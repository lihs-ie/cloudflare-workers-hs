#!/usr/bin/env bash
# KIT_VERSION: 1.1.0
# agent-policy: PostToolUse(Write|Edit) hook。編集された 1 ファイルに対し
# no-prod-doubles / test-bypass を即時チェックし、違反なら exit 2 で編集をブロックする。
# 既存の fitness hook (scripts/fitness/hook.sh) とは独立に、追加 hook として共存させる。
set -uo pipefail

payload="$(cat)"
file_path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"
[ -z "$file_path" ] && exit 0
[ -f "$file_path" ] || exit 0

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root"

# repo-relative path に変換 (allowlist の glob と整合させる)
rel="${file_path#"$repository_root"/}"

violations=""
for script in scripts/verify-no-prod-doubles.sh scripts/verify-test-bypass.sh; do
  [ -x "$script" ] || [ -f "$script" ] || continue
  if ! out="$(bash "$script" "$rel" 2>&1)"; then
    violations="${violations}
== ${script##*/} ==
$out"
  fi
done

if [ -n "$violations" ]; then
  {
    echo "agent-policy 違反があります。修正してください:"
    echo "$violations"
  } >&2
  exit 2
fi
exit 0
