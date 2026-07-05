#!/usr/bin/env bash
# KIT_VERSION: 1.3.0
# agent-policy: collapsed loop (同一 failure_class かつ同一 target_test の red が末尾 3 回連続) を
# PostToolUse hook で live 検出する。従来は Step 4 の事後実行でのみ検出していたため、implementer が
# Step 4 に到達するまで collapsed loop が潜行してしまう欠陥があった (packet-decomposition-checkpoint
# spec Goal の動機の1つ)。この hook は iterations.json への Write/Edit 直後に verify-failure-class.sh
# を起動し、exit 2 (collapsed loop) のときだけ非ブロック警告 (PostToolUse の exit 2 意味論) を出す。
# schema 違反 (exit 1) は Step 4 / static-verifier の担当であり、この hook は関与しない (exit 0)。
#
# 使い方: <hook JSON> | collapsed-loop-guard.sh [--evidence-dir <dir>]  (既定: .agent-evidence)
set -uo pipefail

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root" 2>/dev/null || true

evidence_dir=".agent-evidence"

while [ $# -gt 0 ]; do
  case "$1" in
    --evidence-dir) evidence_dir="${2:-}"; shift 2 ;;
    --evidence-dir=*) evidence_dir="${1#--evidence-dir=}"; shift ;;
    *) shift ;;
  esac
done

payload="$(cat 2>/dev/null || true)"

json_field() {
  # $1 = json string  $2 = jq filter (e.g. '.tool_input.file_path')。jq 優先 + python3 fallback
  # (agent-time-budget.sh:39-62 のパターンを踏襲)。
  local json="$1" filter="$2"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r "$filter // empty" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
path = '$filter'.lstrip('.').split('.')
for p in path:
    if isinstance(data, dict):
        data = data.get(p)
    else:
        data = None
        break
if isinstance(data, str):
    print(data)
" <<< "$json" 2>/dev/null
  fi
}

hook_event_name="$(json_field "$payload" '.hook_event_name')"
tool_name="$(json_field "$payload" '.tool_name')"
file_path="$(json_field "$payload" '.tool_input.file_path')"

# (b) hook_event_name 欠落・未知 -> fail-safe allow + stderr 診断
# (agent-time-budget.sh と同じ fail-safe 方針: field 名変更等でセッションを brick しない)
if [ -z "$hook_event_name" ] || [ "$hook_event_name" != "PostToolUse" ]; then
  echo "collapsed-loop-guard: unknown/missing hook_event_name ('${hook_event_name:-<empty>}') — fail-safe allow" >&2
  exit 0
fi

# tool_name 欠落 -> 同様に fail-safe allow
if [ -z "$tool_name" ]; then
  echo "collapsed-loop-guard: missing tool_name — fail-safe allow" >&2
  exit 0
fi

# (c) tool_name が Write/Edit 以外 -> このガードの対象外 (no-op)
case "$tool_name" in
  Write|Edit) : ;;
  *) exit 0 ;;
esac

[ -n "$file_path" ] || exit 0

# file_path 正規化: 絶対パス解決 (repo-root 相対/絶対どちらの file_path でも一致するように) +
# suffix フォールバック。
normalize_path() {
  local p="$1"
  case "$p" in
    /*) printf '%s' "$p" ;;
    *) printf '%s/%s' "$repository_root" "$p" ;;
  esac
}

iterations_target="${evidence_dir%/}/iterations.json"
target_path="$(normalize_path "$iterations_target")"
input_path="$(normalize_path "$file_path")"

match=0
if [ "$input_path" = "$target_path" ]; then
  match=1
else
  case "$input_path" in
    *"/$iterations_target") match=1 ;;
  esac
fi

[ "$match" = "1" ] || exit 0

# 一致: verify-failure-class.sh を起動し、collapsed loop (exit 2) のみを非ブロック警告として扱う。
verify_output="$(bash "$repository_root/scripts/verify-failure-class.sh" "$iterations_target" 2>&1)"
verify_exit=$?

case "$verify_exit" in
  0|1)
    # exit 0 = 正常 / exit 1 = schema 違反 (Step 4 / static-verifier の担当。この hook は関与しない)
    exit 0
    ;;
  2)
    # Should: failure_class 分布を併記し、単純な繰り返しか同一原因の collapsed loop かを
    # implementer が自己判断しやすくする。
    failure_class_summary="$(grep -o '"failure_class"[[:space:]]*:[[:space:]]*"[^"]*"' "$iterations_target" 2>/dev/null \
      | sed -E 's/.*"([a-zA-Z-]+)"$/\1/' | sort | uniq -c | sort -rn | tr '\n' ' ')"
    {
      echo "collapsed-loop-guard: collapsed loop 検出 (非ブロック警告 — PostToolUse exit 2 意味論)。"
      echo "$verify_output"
      [ -n "$failure_class_summary" ] && echo "failure_class 分布: $failure_class_summary"
    } >&2
    exit 2
    ;;
  *)
    echo "collapsed-loop-guard: verify-failure-class.sh unexpected exit $verify_exit — fail-safe allow" >&2
    exit 0
    ;;
esac
