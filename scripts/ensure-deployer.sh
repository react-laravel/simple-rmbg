#!/bin/bash
# 确保 Deployer 可用；若缺失则下载固定版本，并转发所有参数给 dep。
set -euo pipefail

DEFAULT_DEP_BIN="${HOME}/.deployer/dep.phar"
DEP_VERSION="${DEP_VERSION:-7.5.7}"

log() {
  echo "[ensure-deployer] $*" >&2
}

die() {
  echo "错误：$*" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "缺少命令：$1"
  fi
}

download_deployer() {
  local dep_bin="$DEFAULT_DEP_BIN"

  require_command curl
  require_command mkdir
  require_command chmod
  require_command php

  log "下载 Deployer v${DEP_VERSION} 到 ${dep_bin}"
  mkdir -p "$(dirname "$dep_bin")"
  curl -fsSL "https://deployer.org/releases/v${DEP_VERSION}/deployer.phar" -o "$dep_bin"
  chmod +x "$dep_bin"
}

phar_version_matches() {
  local dep_bin="$1"
  local version_output

  require_command php

  if ! version_output="$(php "$dep_bin" --version 2>/dev/null)"; then
    return 1
  fi

  [[ "$version_output" == *"${DEP_VERSION}"* ]]
}

resolve_deployer_path() {
  local dep_bin="${DEP_BIN:-}"

  if [ -n "$dep_bin" ]; then
    if [ -f "$dep_bin" ]; then
      printf '%s\n' "$dep_bin"
      return
    fi

    if command -v "$dep_bin" >/dev/null 2>&1; then
      command -v "$dep_bin"
      return
    fi

    die "DEP_BIN 不可用：$dep_bin"
  fi

  if [ -f "$DEFAULT_DEP_BIN" ]; then
    if phar_version_matches "$DEFAULT_DEP_BIN"; then
      printf '%s\n' "$DEFAULT_DEP_BIN"
      return
    fi

    log "已缓存的 Deployer 版本不匹配，重新下载 v${DEP_VERSION}"
  fi

  download_deployer
  printf '%s\n' "$DEFAULT_DEP_BIN"
}

run_deployer() {
  local dep_path

  dep_path="$(resolve_deployer_path)"

  if [[ "$dep_path" == *.phar ]]; then
    require_command php
    exec php "$dep_path" "$@"
  fi

  exec "$dep_path" "$@"
}

if [ "$#" -eq 0 ]; then
  set -- --version
fi

run_deployer "$@"
