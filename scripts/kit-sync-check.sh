#!/usr/bin/env bash
# KIT_VERSION: 1.1.0
# agent-policy-kit: 消費 repo 側 scripts/verify-*.sh (vendored copy) が
# kit-manifest.yml の最新版 (単一 KIT_VERSION + per-file sha256) と一致しているか検証する。
# 経路A (sync dry-run diff) と経路B (proven-done Step 0 freshness) はこのスクリプトを共有する
# (判定ロジックの二重実装を避ける)。
#
# Usage:
#   kit-sync-check.sh --check [--manifest <path>] [--target-dir <dir>]
#     消費 repo 側 (既定 target-dir: scripts/) の vendored コピーを manifest と比較する。
#       exit 0: 全一致 (fresh)
#       exit 1: 欠落ファイルあり (ブロック — agent-policy-kit の再適用を促す)
#       exit 2: KIT_VERSION 不一致 or 同一 KIT_VERSION での sha256 drift (陳腐化 — 警告のみ。
#               sync (Detect→Diff→Apply, dry-run 既定) の実行を促す)
#   kit-sync-check.sh --self [--manifest <path>]
#     manifest が指す template ファイル自身が manifest の kit_version / sha256 と
#     一致するか検証する (kit-manifest-update.sh の実行漏れ検出)。
#       exit 0: 一致 / exit 1: 不一致・欠落 (manifest 再生成が必要)
#
# 既定 manifest: dot_claude/skills/agent-policy-kit/kit-manifest.yml
# 既定 target-dir: scripts (--check のみで使用)
set -uo pipefail

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root"

mode=""
manifest=""
target_dir=""

while [ $# -gt 0 ]; do
  case "$1" in
    --check) mode="check"; shift ;;
    --self) mode="self"; shift ;;
    --manifest) manifest="${2:-}"; shift 2 ;;
    --target-dir) target_dir="${2:-}"; shift 2 ;;
    *) echo "kit-sync-check: unknown arg '$1'" >&2; exit 1 ;;
  esac
done

if [ -z "$mode" ]; then
  echo "kit-sync-check: usage: kit-sync-check.sh --check|--self [--manifest <path>] [--target-dir <dir>]" >&2
  exit 1
fi

manifest="${manifest:-dot_claude/skills/agent-policy-kit/kit-manifest.yml}"
target_dir="${target_dir:-scripts}"

if [ ! -f "$manifest" ]; then
  echo "kit-sync-check: manifest not found: $manifest" >&2
  exit 1
fi

manifest_dir="$(dirname "$manifest")"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

kit_version="$(awk -F': ' '/^kit_version:/{v=$2; gsub(/^["'"'"']|["'"'"']$/,"",v); print v; exit}' "$manifest")"
if [ -z "$kit_version" ]; then
  echo "kit-sync-check: manifest missing top-level 'kit_version': $manifest" >&2
  exit 1
fi

# files: セクションを "name<TAB>template<TAB>sha256" のフラットレコードに変換する。
# schema (kit-manifest.yml):
#   files:
#     <name>:
#       template: <path relative to manifest dir>
#       sha256: "<hex>"
records="$(awk '
  function val(s){ sub(/^[^:]*:[[:space:]]*/,"",s); gsub(/^["\x27]|["\x27]$/,"",s); return s }
  /^[[:space:]]{2}[^[:space:]].*:[[:space:]]*$/ {
    if (name != "") print name "\t" tmpl "\t" hash
    line=$0; sub(/^[[:space:]]{2}/,"",line); sub(/:[[:space:]]*$/,"",line); name=line; tmpl=""; hash=""; next
  }
  /^[[:space:]]{4}template:/ { tmpl=val($0); next }
  /^[[:space:]]{4}sha256:/ { hash=val($0); next }
  END { if (name != "") print name "\t" tmpl "\t" hash }
' "$manifest")"

if [ -z "$records" ]; then
  echo "kit-sync-check: manifest has no 'files:' entries: $manifest" >&2
  exit 1
fi

missing=""
stale=""

while IFS=$'\t' read -r name tmpl hash; do
  [ -z "$name" ] && continue
  if [ "$mode" = "self" ]; then
    check_path="$manifest_dir/$tmpl"
    label="$name (template)"
  else
    check_path="$target_dir/$name"
    label="$name"
  fi
  if [ ! -f "$check_path" ]; then
    missing="${missing}  - $label: not found ($check_path)\n"
    continue
  fi
  actual_version="$(awk '/^# KIT_VERSION:/{print $3; exit}' "$check_path")"
  actual_hash="$(sha256_of "$check_path")"
  if [ "$actual_version" != "$kit_version" ]; then
    stale="${stale}  - $label: KIT_VERSION '$actual_version' != manifest '$kit_version' (outdated)\n"
  elif [ "$actual_hash" != "$hash" ]; then
    stale="${stale}  - $label: sha256 mismatch at same KIT_VERSION (drift — hand-edited copy?)\n"
  fi
done <<< "$records"

if [ -n "$missing" ]; then
  echo "kit-sync-check ($mode): MISSING:" >&2
  printf '%b' "$missing" >&2
  if [ "$mode" = "self" ]; then
    echo "kit-manifest-update.sh を実行して kit-manifest.yml を再生成してください。" >&2
  else
    echo "agent-policy-kit skill を再適用して不足スクリプトを scaffold してください。" >&2
  fi
  exit 1
fi

if [ -n "$stale" ]; then
  if [ "$mode" = "self" ]; then
    echo "kit-sync-check (self): STALE — kit-manifest.yml がテンプレートと不整合です:" >&2
    printf '%b' "$stale" >&2
    echo "kit-manifest-update.sh を実行して kit-manifest.yml を再生成してください。" >&2
    exit 1
  fi
  echo "kit-sync-check (check): STALE — sync が必要です:" >&2
  printf '%b' "$stale" >&2
  echo "agent-policy-kit skill の Sync (Detect→Diff→Apply, dry-run 既定) を実行してください。" >&2
  exit 2
fi

echo "kit-sync-check ($mode): OK (kit_version=$kit_version)"
exit 0
