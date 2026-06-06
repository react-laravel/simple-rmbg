#!/bin/bash

set -euo pipefail

BASE_URL="${1:-}"
VERIFY_MAX_ATTEMPTS="${VERIFY_MAX_ATTEMPTS:-20}"
VERIFY_RETRY_DELAY_SECONDS="${VERIFY_RETRY_DELAY_SECONDS:-1}"
VERIFY_CURL_MAX_TIME_SECONDS="${VERIFY_CURL_MAX_TIME_SECONDS:-15}"

shift || true

if [ -z "$BASE_URL" ]; then
  echo "用法: bash scripts/verify-next-assets.sh <base-url> [route ...]" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- /
fi

extract_asset_paths() {
  grep -oE '(src|href)="/_next/static/[^"]+"' \
    | sed -E 's/^(src|href)="([^"]+)"$/\2/' \
    | awk '!seen[$0]++'
}

fetch_url_body() {
  local url="$1"
  local attempt=1
  local response

  while [ "$attempt" -le "$VERIFY_MAX_ATTEMPTS" ]; do
    if response="$(curl -fsSL --max-time "$VERIFY_CURL_MAX_TIME_SECONDS" "$url")"; then
      printf '%s' "$response"
      return 0
    fi

    if [ "$attempt" -lt "$VERIFY_MAX_ATTEMPTS" ]; then
      echo "[verify] 等待 $url 就绪（$attempt/$VERIFY_MAX_ATTEMPTS）" >&2
      sleep "$VERIFY_RETRY_DELAY_SECONDS"
    fi

    attempt=$((attempt + 1))
  done

  echo "[verify] $url 在 $VERIFY_MAX_ATTEMPTS 次尝试后仍不可访问" >&2
  return 1
}

fetch_url_status() {
  local url="$1"
  local attempt=1
  local status

  while [ "$attempt" -le "$VERIFY_MAX_ATTEMPTS" ]; do
    status="$(curl -s -L -o /dev/null -w '%{http_code}' --max-time "$VERIFY_CURL_MAX_TIME_SECONDS" "$url")"

    if [ "$status" -ge 200 ] && [ "$status" -lt 400 ]; then
      printf '%s' "$status"
      return 0
    fi

    if [ "$attempt" -lt "$VERIFY_MAX_ATTEMPTS" ]; then
      echo "[verify] 等待静态资源 $url 就绪（$attempt/$VERIFY_MAX_ATTEMPTS，当前 $status）" >&2
      sleep "$VERIFY_RETRY_DELAY_SECONDS"
    fi

    attempt=$((attempt + 1))
  done

  printf '%s' "$status"
  return 1
}

check_route_assets() {
  local route="$1"
  local base_url="${BASE_URL%/}"
  local page_url="${base_url}${route}"
  local html
  local assets
  local count=0

  html="$(fetch_url_body "$page_url")"
  assets="$(printf '%s' "$html" | extract_asset_paths)"

  if [ -z "$assets" ]; then
    echo "[verify] $page_url 未找到任何 /_next/static 资源引用" >&2
    return 1
  fi

  while IFS= read -r asset; do
    local status

    [ -n "$asset" ] || continue
    if ! status="$(fetch_url_status "${base_url}${asset}")"; then
      echo "[verify] $page_url 引用的资源 ${base_url}${asset} 返回 $status" >&2
      return 1
    fi

    count=$((count + 1))
  done <<< "$assets"

  echo "[verify] $page_url 通过，共检查 $count 个静态资源"
}

for route in "$@"; do
  check_route_assets "$route"
done
