<?php

/**
 * Deployer 部署配置（GitHub Actions self-hosted runner 使用）
 *
 * 设计要点：
 * - self-hosted runner 就在目标服务器上，host 用 localhost() 走本地 shell，无需 SSH。
 * - 代码来源直接使用当前 Actions checkout 工作区，避免在部署阶段再次 clone 仓库。
 * - models/ 与 .cache/ 跨 release 共享，避免每次发布重复上传 ~1GB 模型权重。
 * - Next.js 构建完成后通过 PM2 reload current，对外保持零停机切换。
 *
 * 本地使用：
 *   DEPLOY_PATH=/example/simple-rmbg PM2_APP=simple-rmbg-nextjs vendor/bin/dep deploy production
 *
 * 回滚：
 *   vendor/bin/dep rollback production
 */

namespace Deployer;

require 'recipe/common.php';

// =====================
// 基本配置
// =====================
set('application', 'simple-rmbg');
set('keep_releases', 2);
set('git_tty', false);
set('workspace_root', __DIR__);
set('writable_mode', 'chmod');
set('writable_recursive', true);
set('writable_chmod_mode', '0775');
set('verify_base_url', getenv('VERIFY_BASE_URL') ?: '');
set('local_healthcheck_base_url', 'http://127.0.0.1:' . (getenv('PORT') ?: '3000'));

add('shared_dirs', ['logs', 'models', '.cache']);
add('writable_dirs', ['logs']);

// =====================
// Hosts
// =====================
localhost('production')
    ->set('deploy_path', getenv('DEPLOY_PATH') ?: getenv('APP_ROOT') ?: '/example/simple-rmbg')
    ->set('pm2_app', getenv('PM2_APP') ?: 'simple-rmbg-nextjs');

// =====================
// 自定义任务
// =====================
desc('部署前检查关键目录权限');
task('deploy:preflight_permissions', function () {
    run(<<<'BASH'
bash -lc '
set -euo pipefail

workspace_root="{{workspace_root}}"
deploy_path="{{deploy_path}}"
expected_user="${DEPLOY_USER:-nginx}"
actual_user="$(id -un)"

if [ "$actual_user" != "$expected_user" ]; then
  echo "[deploy] ERROR: 部署必须以 $expected_user 用户运行，当前是 $actual_user" >&2
  echo "[deploy] 修复：检查 GitHub Actions runner systemd User=、手工 deploy/sudo 命令以及 PM2_HOME。" >&2
  exit 73
fi

check_tree_writable() {
  local label="$1"
  local path="$2"

  [ -e "$path" ] || return 0

  local bad_owner bad_dirs
  bad_owner="$({ find "$path" -maxdepth 8 ! -user "$actual_user" -printf "%u:%g %m %p\n" | head -40; } || true)"
  bad_dirs="$({ find "$path" -maxdepth 8 -type d ! -writable -printf "%u:%g %m %p\n" | head -40; } || true)"

  if [ -n "$bad_owner" ] || [ -n "$bad_dirs" ]; then
    echo "[deploy] ERROR: $label 存在权限漂移：" >&2
    if [ -n "$bad_owner" ]; then
      echo "[deploy] 非 $actual_user 所有的路径：" >&2
      echo "$bad_owner" >&2
    fi
    if [ -n "$bad_dirs" ]; then
      echo "[deploy] 当前用户不可写的目录：" >&2
      echo "$bad_dirs" >&2
    fi
    echo "[deploy] 修复：sudo chown -R $actual_user:$actual_user \"$path\"，并停止 root PM2/LSP/手工进程。" >&2
    exit 74
  fi
}

check_tree_writable "Actions 工作区" "$workspace_root"
check_tree_writable "部署目录" "$deploy_path"
'
BASH);
});

desc('从当前工作区同步代码到 release 目录');
task('deploy:update_code', function () {
    $workspaceRoot = rtrim(get('workspace_root'), '/');
    $releasePath = '{{release_path}}';

    run("mkdir -p $releasePath");
    run(
        'rsync -a '
        . "--exclude='.git' "
        . "--exclude='node_modules' "
        . "--exclude='.next' "
        . "--exclude='models' "
        . "--exclude='.cache' "
        . "--exclude='coverage' "
        . "--exclude='logs' "
        . "--exclude='releases' "
        . "--exclude='current' "
        . "--exclude='.build-staging.*' "
        . "$workspaceRoot/ $releasePath/"
    );
});

desc('把旧部署目录中的本地配置文件覆盖到新 release');
task('deploy:runtime_files', function () {
    $deployPath = '{{deploy_path}}';
    $releasePath = '{{release_path}}';

    run(<<<'BASH'
bash -lc '
for file in .env .env.local .env.production .env.production.local .npmrc; do
  if [ -f "{{deploy_path}}/$file" ]; then
    cp "{{deploy_path}}/$file" "{{release_path}}/$file"
  fi
done
'
BASH);

    run("mkdir -p $releasePath/logs");
});

desc('安装 Node.js 依赖');
task('deploy:vendors', function () {
    run('cd {{release_path}} && npm ci');
});

desc('构建 Next.js 生产产物');
task('deploy:build', function () {
    run('cd {{release_path}} && npm run build');
});

desc('保留跨发布的 Next 静态资源');
task('deploy:preserve_next_static', function () {
    run(<<<'BASH'
bash -lc '
set -euo pipefail

shared_static="{{deploy_path}}/shared/.next-static"
current_static="{{current_path}}/.next/static"
release_static="{{release_path}}/.next/static"
releases_root="{{deploy_path}}/releases"

sync_static_dir() {
  local static_dir="$1"
  local static_real
  local shared_real

  [ -d "$static_dir" ] || return 0
  mkdir -p "$shared_static"

  static_real="$(cd "$static_dir" && pwd -P)"
  shared_real="$(cd "$shared_static" && pwd -P)"

  if [ "$static_real" = "$shared_real" ]; then
    return 0
  fi

  rsync -a "$static_dir/" "$shared_static/"
}

if [ -d "$releases_root" ]; then
  while IFS= read -r release_dir; do
    [ -n "$release_dir" ] || continue
    sync_static_dir "$release_dir/.next/static"
  done < <(find "$releases_root" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' | sort)
fi

sync_static_dir "$current_static"
sync_static_dir "$release_static"

rm -rf "$release_static"
ln -sfn "$shared_static" "$release_static"
'
BASH);
});

desc('移除构建清单中不存在的 Next 静态资源引用');
task('deploy:prune_missing_next_static_refs', function () {
    run(<<<'BASH'
bash -lc '
set -euo pipefail

release_root="{{release_path}}"
static_root="$release_root/.next/static"
server_root="$release_root/.next/server"

[ -d "$server_root" ] || exit 0

python3 - "$server_root" "$static_root" <<"PY"
import json
import pathlib
import sys

server_root = pathlib.Path(sys.argv[1])
static_root = pathlib.Path(sys.argv[2])
changed = 0
removed = set()

for manifest in server_root.glob("**/react-loadable-manifest.json"):
    try:
        data = json.loads(manifest.read_text())
    except Exception:
        continue

    dirty = False
    for entry in data.values():
        if not isinstance(entry, dict):
            continue
        files = entry.get("files")
        if not isinstance(files, list):
            continue

        kept = []
        for file_name in files:
            if (
                isinstance(file_name, str)
                and file_name.startswith("static/")
                and not (static_root / file_name.removeprefix("static/")).exists()
            ):
                removed.add(file_name)
                dirty = True
                continue
            kept.append(file_name)
        entry["files"] = kept

    if dirty:
        manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        changed += 1

if removed:
    print(f"[deploy] pruned {len(removed)} missing static refs from {changed} react-loadable manifests")
    for file_name in sorted(removed):
        print(f"[deploy] missing static ref: {file_name}")
PY
'
BASH);
});

desc('重启 PM2 应用');
task('pm2:restart', function () {
    run(<<<'BASH'
bash -lc '
app_name="{{pm2_app}}"
runtime_cwd="{{current_path}}"
ecosystem_path="{{current_path}}/ecosystem.config.js"

pm2_untracked() {
  env -u RUNNER_TRACKING_ID pm2 "$@"
}

if pm2_untracked info "$app_name" >/dev/null 2>&1; then
  echo "[deploy] 重启 PM2 应用: $app_name"

  if env -u RUNNER_TRACKING_ID PM2_CWD="$runtime_cwd" APP_ROOT="{{deploy_path}}" pm2 restart "$ecosystem_path" --only "$app_name" --update-env; then
    pm2_untracked status
    exit 0
  fi

  echo "[deploy] PM2 restart 失败，尝试重建应用进程表"
  pm2_untracked delete "$app_name" || true
fi

if ! pm2_untracked info "$app_name" >/dev/null 2>&1; then
  echo "[deploy] PM2 中未找到应用，准备首次启动: $app_name"
fi

env -u RUNNER_TRACKING_ID PM2_CWD="$runtime_cwd" APP_ROOT="{{deploy_path}}" pm2 start "$ecosystem_path" --only "$app_name" --update-env
pm2_untracked status
'
BASH);
});

desc('校验页面引用的 Next 静态资源可访问');
task('deploy:healthcheck', function () {
    run(<<<'BASH'
bash -lc '
set -euo pipefail

verify_script="{{current_path}}/scripts/verify-next-assets.sh"
local_base_url="{{local_healthcheck_base_url}}"
public_base_url="{{verify_base_url}}"

bash "$verify_script" "$local_base_url" /

if [ -n "$public_base_url" ]; then
  bash "$verify_script" "$public_base_url" /
fi
'
BASH);
});

// =====================
// 部署流程
// =====================
desc('部署 simple-rmbg');
task('deploy', [
    'deploy:info',
    'deploy:setup',
    'deploy:lock',
    'deploy:preflight_permissions',
    'deploy:release',
    'deploy:update_code',
    'deploy:runtime_files',
    'deploy:shared',
    'deploy:writable',
    'deploy:vendors',
    'deploy:build',
    'deploy:preserve_next_static',
    'deploy:prune_missing_next_static_refs',
    'deploy:symlink',
    'pm2:restart',
    'deploy:healthcheck',
    'deploy:unlock',
    'deploy:cleanup',
    'deploy:success',
]);

after('deploy:failed', 'deploy:unlock');
after('rollback', 'pm2:restart');
