#!/usr/bin/env bash
# KIT_VERSION: 1.3.0
# agent-policy: PreToolUse(Write|Edit) と PostToolUse(Write|Edit) の両方に登録する hook。
# PostToolUse: 編集された 1 ファイルに対し no-prod-doubles / test-bypass を即時チェックし、
#   違反なら exit 2 で編集をブロックする (既存動作、無変更)。
# PreToolUse: Must-18 (orchestrator-direct-implementation blocking — docs/specs/harness-campaign-fix2-6.md)。
# 既存の fitness hook (scripts/fitness/hook.sh) とは独立に、追加 hook として共存させる。
#
# Must-18 Q1 investigation (discriminator の実測調査、2026-07-05):
# Claude Code hook の stdin JSON (hook_event_name/tool_name/tool_input) には、
# 「orchestrator (main thread) が発行した tool call」と「Task で起動された subagent が発行した
# tool call」を区別するフィールドは無い (既存の agent-time-budget.sh/agent-policy-hook.sh の
# 実装が hook_event_name/tool_name/tool_input の 3 フィールドしか参照していないことからも、
# repo 内に他フィールドの使用実績が無いことを確認済み)。
# 実測: 本タスクの実装 subagent 自身のプロセス環境 (`env | grep -i claude`) を調べたところ、
# `CLAUDE_CODE_CHILD_SESSION=1` が実際に設定されていた (該当 subagent の
# `~/.claude/projects/.../subagents/<id>.meta.json` が `agentType=implementer` を記録しており、
# この env var の値と符合する)。hook はツール呼び出しを発行したプロセス (orchestrator 本体 or
# subagent) のサブプロセスとして起動されるため、この env var を継承する。
# **採用した discriminator**: `CLAUDE_CODE_CHILD_SESSION` が `1` でなければ (未設定/空を含む)
# orchestrator (main thread) からの呼び出しとみなす。
# **限界 (正直に記録する)**: この結論は subagent 自身の環境から観測した実測に基づくものであり、
# 別プロセスである orchestrator 本体の環境変数を直接観測して「常に未設定である」ことまでは
# 確認できていない。この env var の意味論が将来変わる、またはホスト構成によって伝播しない場合、
# この検出は誤検出/検出漏れを起こしうる。新たな hook payload フィールドを独自に発明することは
# せず (Non-goal)、現時点で確認できた最善のシグナルとして採用する。
set -uo pipefail

payload="$(cat)"
hook_event_name="$(printf '%s' "$payload" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null || true)"
file_path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root" 2>/dev/null || true

evidence_dir="${EVIDENCE_DIR_OVERRIDE:-.agent-evidence}"

# --- Must-18: PreToolUse orchestrator-direct-implementation 検出 (block, exit 2) ---
if [ "$hook_event_name" = "PreToolUse" ]; then
  if { [ "$tool_name" = "Write" ] || [ "$tool_name" = "Edit" ]; } \
    && [ -f "$evidence_dir/.active" ] \
    && [ -n "$file_path" ] \
    && [ "${CLAUDE_CODE_CHILD_SESSION:-}" != "1" ]; then
    rel_check="$file_path"
    case "$file_path" in
      /*) rel_check="${file_path#"$repository_root"/}" ;;
    esac
    test_dir_re='(^|/)(test|tests|__tests__|spec|specs|fixtures|testdata|mocks?|stubs?|fakes?)(/|$)'
    if [ "$rel_check" != ".agent-evidence" ] && [[ "$rel_check" != .agent-evidence/* ]] \
      && ! printf '%s' "$rel_check" | grep -Eq "$test_dir_re"; then
      allowlisted=0
      if [ -f "ci/allowlist.yml" ] \
        && grep -v '^[[:space:]]*#' ci/allowlist.yml | grep -q "rule: orchestrator-direct-implementation" 2>/dev/null; then
        allowlisted=1
      fi
      if [ "$allowlisted" -eq 0 ]; then
        {
          echo "POLICY VIOLATION: orchestrator-direct-implementation (Must-18)."
          echo "本番パス '$rel_check' への Write/Edit が、proven-done タスク実行中 (.agent-evidence/.active 存在)"
          echo "かつ subagent 由来ではない (CLAUDE_CODE_CHILD_SESSION!=1) 呼び出しで検出されました。"
          echo "orchestrator は implementer に委譲してください (自ら本番コードを実装しない)。"
          echo "既知の false positive がある場合は ci/allowlist.yml に"
          echo "'rule: orchestrator-direct-implementation' エントリ (owner/reason/expires_at 付き) を追加してください。"
        } >&2
        exit 2
      fi
    fi
  fi
  exit 0
fi

# --- PostToolUse (既存動作、無変更): no-prod-doubles / test-bypass ---
[ -z "$file_path" ] && exit 0
[ -f "$file_path" ] || exit 0

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
