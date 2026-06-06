# 部署指南（Deployer + GitHub Actions Self-hosted Runner）

本文描述如何用 [Deployer](https://deployer.org) 对 `simple-rmbg` 做零停机部署，触发方式是推送 `main` 自动跑。

---

## 1. 两套部署方案

| 方案 | 入口 | 说明 |
| --- | --- | --- |
| **Deployer（推荐）** | `.github/workflows/deploy-self-hosted.yml` | 推送 main 自动部署，内置 rollback / unlock |
| **Shell 脚本（回退）** | `scripts/deploy-zero-downtime.sh` | 迁移过渡期保留，逻辑与 Deployer 类似 |

两种方案均保留 **2 个历史 release**（`keep_releases = 2`），便于快速回滚且节省磁盘。

---

## 2. 目录约定

服务器上部署根目录（默认 `/example/simple-rmbg`，通过 `DEPLOY_PATH` 配置）结构：

```plaintext
/example/simple-rmbg/
├── .dep/                 Deployer 内部状态（锁、历史）
├── current/              -> releases/<timestamp>
├── releases/
│   ├── 20260419183000/
│   └── 20260420090000/
├── shared/
│   ├── models/           RMBG-2.0 权重（~1GB，跨 release 共享）
│   ├── .cache/           transformers.js 缓存
│   └── .next-static/     Next 静态资源
├── logs/                 PM2 日志（shared 软链）
├── .env.local            服务器本地配置（可选）
└── .env.production       服务器本地配置（可选）
```

- Nginx / 反向代理指向 `current`
- PM2 的 `cwd` 指向 `current`
- 模型权重放在 `shared/models/RMBG-2.0/`，**不会**随 git 部署

---

## 3. 前置条件

### 3.1 服务器软件

- Node.js 24、npm 10+
- GitHub self-hosted runner
- PM2
- Nginx 或其他反向代理
- PHP 8+（Deployer 运行时需要）

### 3.2 模型权重

首次部署前，把 RMBG-2.0 模型上传到 `shared/models/`：

```bash
mkdir -p /example/simple-rmbg/shared/models
tar -xzf rmbg-2.0.tar.gz -C /example/simple-rmbg/shared/models
# 确认存在：shared/models/RMBG-2.0/onnx/model.onnx
```

在 `.env.local` 中设置：

```bash
MODEL_LOCAL_ONLY=true
```

### 3.3 PM2

`ecosystem.config.js` 已配置：

- 应用名：`simple-rmbg-nextjs`
- 启动命令：`npm run start`
- `cwd` 优先使用 `PM2_CWD`，Deployer 切换 `current` 后可直接 reload
- `max_memory_restart: 3G`（模型推理需要较大内存）

### 3.4 首次部署

在 runner 机器上的工作树里执行：

```bash
DEPLOY_PATH=/example/simple-rmbg scripts/first-deploy.sh
```

或手动初始化目录后，直接触发 GitHub Actions 部署。

---

## 4. GitHub Secrets

仓库 Settings → Secrets and variables → Actions 配置：

| Secret 名     | 值示例                  | 说明                 |
| ------------- | ----------------------- | -------------------- |
| `DEPLOY_PATH` | `/example/simple-rmbg`  | 部署根目录（必填）   |
| `PM2_APP`     | `simple-rmbg-nextjs`    | PM2 应用名（可选）   |

---

## 5. 自动部署流程

`.github/workflows/deploy-self-hosted.yml` 已配置：

1. 推送 `main` 或手动点 "Run workflow" 触发
2. Runner checkout 仓库
3. 下载 / 复用 `~/.deployer/dep.phar`
4. 执行 `dep deploy production -v`
5. Deployer 依次：同步工作区 → 复制 .env → shared link（models/.cache）→ `npm ci` → `npm run build` → 切换 `current` → `pm2 reload`

全程 `current` 直到最后一刻才切换，HTTP 请求不中断。

---

## 6. 手动命令

```bash
scripts/ensure-deployer.sh deploy production
scripts/ensure-deployer.sh rollback production
scripts/ensure-deployer.sh deploy:unlock production
scripts/ensure-deployer.sh releases production
```

回退到 Shell 脚本：

```bash
DEPLOY_PATH=/example/simple-rmbg scripts/deploy-zero-downtime.sh
```

---

## 7. 故障排查

| 现象                   | 排查                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| `Deploy is locked`     | 执行 `scripts/ensure-deployer.sh deploy:unlock production`                 |
| API 返回 503           | 检查 `shared/models/RMBG-2.0/onnx/model.onnx` 是否存在，`.env` 是否配置   |
| `npm ci` 失败          | 检查 Node / npm 版本                                                       |
| `next build` 失败      | 在 release 目录手动执行 `npm run build` 复现                               |
| `pm2 reload` 失败      | `pm2 logs simple-rmbg-nextjs`、`pm2 status`                                |
| 页面没更新             | `readlink /example/simple-rmbg/current` 确认 `current` 是否已切到新 release |

查看详细输出：

```bash
scripts/ensure-deployer.sh deploy production -vvv
```
