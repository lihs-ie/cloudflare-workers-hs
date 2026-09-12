#!/usr/bin/env bash
# KIT_VERSION: 1.1.0
# agent-policy-kit: kit-manifest.yml (templates/scripts/executable_*.sh の
# sha256 + 単一 KIT_VERSION) を再生成する。経路C: テンプレート修正時にこれを実行して
# manifest を最新化する。kit-sync-check.sh --self で生成結果 (manifest vs template) の
# 整合を検証できる。kit 側 (このリポジトリ) のメンテナンス専用ツールであり、
# 消費 repo 側の scaffold 対象ではない (Sync 経路A/Bは kit-sync-check.sh のみを使う)。
#
# Usage: kit-manifest-update.sh [--kit-root <dir>] [--manifest <path>]
set -euo pipefail

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root"

kit_root="dot_claude/skills/agent-policy-kit"
manifest=""

while [ $# -gt 0 ]; do
  case "$1" in
    --kit-root) kit_root="${2:-}"; shift 2 ;;
    --manifest) manifest="${2:-}"; shift 2 ;;
    *) echo "kit-manifest-update: unknown arg '$1'" >&2; exit 1 ;;
  esac
done

manifest="${manifest:-$kit_root/kit-manifest.yml}"
templates_dir="$kit_root/templates/scripts"

if [ ! -d "$templates_dir" ]; then
  echo "kit-manifest-update: templates dir not found: $templates_dir" >&2
  exit 1
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

shopt -s nullglob
files=("$templates_dir"/executable_*.sh)
shopt -u nullglob
if [ "${#files[@]}" -eq 0 ]; then
  echo "kit-manifest-update: no executable_*.sh templates found in $templates_dir" >&2
  exit 1
fi

kit_version=""
entries=""
for f in "${files[@]}"; do
  base="$(basename "$f")"
  dist_name="${base#executable_}"
  version_line="$(awk '/^# KIT_VERSION:/{print $3; exit}' "$f")"
  if [ -z "$version_line" ]; then
    echo "kit-manifest-update: $f is missing a '# KIT_VERSION: <semver>' line (shebang 直後)" >&2
    exit 1
  fi
  if [ -z "$kit_version" ]; then
    kit_version="$version_line"
  elif [ "$kit_version" != "$version_line" ]; then
    echo "kit-manifest-update: KIT_VERSION mismatch across templates ('$kit_version' vs '$version_line' in $f) — kit uses a single version across all scripts" >&2
    exit 1
  fi
  hash="$(sha256_of "$f")"
  entries="${entries}  ${dist_name}:\n    template: templates/scripts/${base}\n    sha256: \"${hash}\"\n"
done

{
  echo "# kit-manifest.yml — agent-policy-kit 単一 KIT_VERSION + per-file sha256 manifest."
  echo "# 生成: kit-manifest-update.sh。手編集禁止 — templates/scripts/ を直してから再生成する。"
  echo "kit_version: \"${kit_version}\""
  echo "files:"
  printf '%b' "$entries"
} > "$manifest"

echo "kit-manifest-update: wrote $manifest (kit_version=$kit_version, ${#files[@]} files)"
