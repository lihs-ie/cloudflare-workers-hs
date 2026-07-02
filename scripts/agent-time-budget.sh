#!/usr/bin/env bash
# KIT_VERSION: 1.1.0
# agent-policy: proven-done の Time budget (light=30min / heavy=90min) を hook で決定論的に執行する。
# PreToolUse **と** PostToolUse の両方に登録し、stdin の hook JSON の hook_event_name で分岐する
# (docs/specs/agent-time-budget-hook.md Amendments Q3):
#   - PreToolUse:  経過率(ratio) >= 1.0 (100%) で exit 2 (deny) — tool call 自体をブロックしループを
#                  強制停止する。< 100% は exit 0 (無警告)。
#   - PostToolUse: 0.75 <= ratio < 1.0 (75%〜100%) で exit 2 — tool は既に実行済みのため実行はブロック
#                  しないが、Claude Code の公式仕様上 exit 2 の stderr は agent に届く
#                  (非ブロック警告の意味論)。それ以外は exit 0。
# 例外 (最優先で判定): tool_name が Write/Edit で、tool_input.file_path を repo-root 相対に正規化した
# 結果が .agent-evidence/ 配下なら、上記いずれの帯域でも常に exit 0 (deny 帯からの退避路 —
# agent が time-budget-exceeded.md を書いて Step 10 に進めるようにするため)。
# `.agent-evidence/.active` (task=/started_at=/lane= の marker) が無ければ no-op (exit 0)。
# started_at (ISO8601 UTC) の parse に失敗した場合は、壊れた marker でセッションを brick しないよう
# fail-safe で exit 0 とする。lane 欠落/未知値は heavy (90min) として扱う (安全側デフォルト)。
# hook_event_name が欠落/未知の場合も同様に fail-safe allow (exit 0) とするが、無言にはせず
# stderr に 1 行診断を出す (field 名変更等でセッションが brick しないよう fail-closed にはしない —
# docs/specs/agent-time-budget-hook.md Amendment 追記/static-review CONCERNS 対応)。
#
# 使い方: <hook JSON> | agent-time-budget.sh [--evidence-dir <dir>]  (既定: .agent-evidence)
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
  # $1 = json string  $2 = jq filter (e.g. '.tool_input.file_path')。jq 優先 + python3 fallback。
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

# (b) 例外判定を最優先: Write/Edit の file_path が (実) .agent-evidence/ 配下なら常に allow。
# --evidence-dir はテスト用の budget 判定対象ディレクトリの上書きであり、この例外の対象は常に
# 実際の repo root 直下の .agent-evidence/ (ハードコード) — 退避路の実体そのものを保護するため。
if [ "$tool_name" = "Write" ] || [ "$tool_name" = "Edit" ]; then
  if [ -n "$file_path" ]; then
    rel_path="$file_path"
    case "$file_path" in
      /*) rel_path="${file_path#"$repository_root"/}" ;;
    esac
    case "$rel_path" in
      .agent-evidence/*|.agent-evidence)
        exit 0
        ;;
    esac
  fi
fi

active_file="$evidence_dir/.active"

# (c) marker 不在 -> allow
[ -f "$active_file" ] || exit 0

started_at="$(grep '^started_at=' "$active_file" 2>/dev/null | head -1 | cut -d'=' -f2-)"
lane="$(grep '^lane=' "$active_file" 2>/dev/null | head -1 | cut -d'=' -f2-)"

case "$lane" in
  light) budget_minutes=30 ;;
  *) lane="heavy"; budget_minutes=90 ;;
esac

# started_at 無し -> fail-safe allow (壊れた marker でセッションを brick しない)
[ -n "$started_at" ] || exit 0

parse_iso8601_epoch() {
  local iso="$1" epoch=""
  # BSD date (macOS) 優先、失敗したら GNU date にフォールバック。
  epoch="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null)" && { printf '%s' "$epoch"; return 0; }
  epoch="$(date -u -d "$iso" +%s 2>/dev/null)" && { printf '%s' "$epoch"; return 0; }
  return 1
}

started_epoch="$(parse_iso8601_epoch "$started_at")" || exit 0
[ -n "$started_epoch" ] || exit 0

now_epoch="$(date -u +%s)"
elapsed_seconds=$((now_epoch - started_epoch))
[ "$elapsed_seconds" -lt 0 ] && elapsed_seconds=0

budget_seconds=$((budget_minutes * 60))
ratio_permille=$(( elapsed_seconds * 1000 / budget_seconds ))
elapsed_minutes=$(( elapsed_seconds / 60 ))
percent=$(( ratio_permille / 10 ))

case "$hook_event_name" in
  PreToolUse)
    if [ "$ratio_permille" -ge 1000 ]; then
      {
        echo "time budget 超過 (lane=${lane}, ${elapsed_minutes} 分経過)。"
        echo ".agent-evidence/time-budget-exceeded.md に状態を書き Step 10 へ。"
        echo "解除は rm .agent-evidence/.active または started_at 更新"
      } >&2
      exit 2
    fi
    exit 0
    ;;
  PostToolUse)
    if [ "$ratio_permille" -ge 750 ] && [ "$ratio_permille" -lt 1000 ]; then
      echo "budget の ${percent}% 消費 (lane=${lane}, ${elapsed_minutes} 分経過) — 収束を急ぎ、残作業を絞れ" >&2
      exit 2
    fi
    exit 0
    ;;
  *)
    echo "agent-time-budget: unknown/missing hook_event_name — fail-safe allow" >&2
    exit 0
    ;;
esac
