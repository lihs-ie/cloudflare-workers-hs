#!/usr/bin/env bash
# KIT_VERSION: 1.3.0
# agent-policy: Stop hook 証跡完了ゲート (Amendment A5)。
# proven-done 実行中マーカー (.agent-evidence/.active) がある時だけ発火する。
# マーカーが無い通常セッションでは完全な no-op (他作業を妨げない)。
#
# A5: completion-report.md の `status:` ヘッダ (living document、Step 3 開始時から運用) で
# 3 分岐する (「途中停止」と「完了主張」を区別できない旧設計の欠陥修正 — pipeline 進行中の
# 正当な一時停止 (background subagent 待ち / AskUserQuestion 待ち) が誤って block される事故を防ぐ):
#   (a) completion-report.md 不在 or `status: in-progress` -> 途中停止として allow。
#       ただし commands.txt 非空を要求 (最低限の作業ログ強制)。
#   (b) `status: complete` -> 証跡 3 点セット (completion-report.md/commands.txt/wiring-map.json) 非空、
#       かつ最新 round-<N>/ (番号最大、verify-evidence-freshness.sh と同ロジック) の done-eval.json 非空、
#       かつ最新 round の verify-*.log に未 waive の "POLICY VIOLATION" (Must-5) が無いことを要求。
#   (c) `status: escalated` -> escalation-*.md か time-budget-exceeded.md が非空で存在すれば allow。
# `status:` 行欠落 (legacy — 旧形式の completion-report.md) は保守的に (b) complete 扱いとする
# (完了主張の見逃しより誤 block を選ぶ)。
#
# Must-5 (POLICY VIOLATION waiver): quarantine (既定 ci/quarantine.yml) の `gates:` エントリで
# `gate` フィールドが対象ゲート名 (verify-<name>.sh) に部分一致し、`expires_at` が実行日以降
# (未期限切れ) かつ `substitute_verification` が非空なら waive 済みとみなす。この判定は
# **形式的整合性チェックに限定**し、代替検証証跡の実体確認は done-evaluator の意味判定に委ねる
# (二重実装しない)。
#
# 使い方: agent-evidence-gate.sh [--evidence-dir <dir>] [--quarantine <file>]
#   既定: --evidence-dir .agent-evidence / --quarantine ci/quarantine.yml
set -uo pipefail

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root" 2>/dev/null || true

evidence_dir=".agent-evidence"
quarantine_file="ci/quarantine.yml"

while [ $# -gt 0 ]; do
  case "$1" in
    --evidence-dir) evidence_dir="${2:-}"; shift 2 ;;
    --evidence-dir=*) evidence_dir="${1#--evidence-dir=}"; shift ;;
    --quarantine) quarantine_file="${2:-}"; shift 2 ;;
    --quarantine=*) quarantine_file="${1#--quarantine=}"; shift ;;
    *) shift ;;
  esac
done

marker="$evidence_dir/.active"

# マーカー無し -> 関与しない
[ -f "$marker" ] || exit 0

cat >/dev/null 2>&1 || true   # stdin payload (Stop hook JSON) は読み捨て

completion_report="$evidence_dir/completion-report.md"
commands_file="$evidence_dir/commands.txt"
wiring_file="$evidence_dir/wiring-map.json"

# --- branch 判定: completion-report.md の status: ヘッダ ---
branch="in-progress"
if [ -f "$completion_report" ]; then
  status_value="$(grep -m1 -E '^status:[[:space:]]*' "$completion_report" 2>/dev/null | sed -E 's/^status:[[:space:]]*//' | tr -d '[:space:]\r')"
  case "$status_value" in
    in-progress) branch="in-progress" ;;
    escalated)   branch="escalated" ;;
    complete)    branch="complete" ;;
    *)           branch="complete" ;;  # ヘッダ欠落/未知値 -> 保守的に complete 扱い (legacy)
  esac
fi

block() {
  # $1 = メッセージ本文 (複数行可)
  {
    echo "完了報告をブロックしました (agent-policy 証跡ゲート, branch=$branch)。"
    printf '%s\n' "$1"
    echo ""
    echo "proven-done を実行していないのにこれが出る場合は、古いマーカーが残っています。"
    echo "次で解除してください: rm '$marker'"
  } >&2
  exit 2
}

# --- (a) in-progress: 途中停止として allow。commands.txt 非空のみ要求 ---
if [ "$branch" = "in-progress" ]; then
  if [ ! -s "$commands_file" ]; then
    block "status: in-progress (途中停止) ですが commands.txt が未提出/空です: $commands_file"
  fi
  exit 0
fi

# --- (c) escalated: escalation-*.md か time-budget-exceeded.md の非空存在のみ要求 ---
if [ "$branch" = "escalated" ]; then
  found=""
  if [ -s "$evidence_dir/time-budget-exceeded.md" ]; then
    found=1
  else
    shopt -s nullglob
    for f in "$evidence_dir"/escalation-*.md; do
      [ -s "$f" ] && { found=1; break; }
    done
    shopt -u nullglob
  fi
  if [ -z "$found" ]; then
    block "status: escalated ですが escalation-*.md / time-budget-exceeded.md が見当たりません (evidence_dir=$evidence_dir)"
  fi
  exit 0
fi

# --- (b) complete: 3 点セット + 最新 round の done-eval.json + POLICY VIOLATION waiver ---
missing=""
for f in "$completion_report" "$commands_file" "$wiring_file"; do
  [ -s "$f" ] || missing="${missing} $(basename "$f")"
done
if [ -n "$missing" ]; then
  block "status: complete ですが以下の証跡が未提出/空です:${missing}"
fi

# 最新 round-<N>/ (verify-evidence-freshness.sh と同じ「番号最大」判定ロジック)
latest_round=""
latest_n=-1
for d in "$evidence_dir"/round-*; do
  [ -d "$d" ] || continue
  base="$(basename "$d")"
  n="${base#round-}"
  case "$n" in
    ''|*[!0-9]*) continue ;;
  esac
  if [ "$n" -gt "$latest_n" ]; then
    latest_n="$n"
    latest_round="$d"
  fi
done

if [ -z "$latest_round" ] || [ ! -s "$latest_round/done-eval.json" ]; then
  block "status: complete ですが最新 round の done-eval.json が見つからない/空です (latest_round=${latest_round:-<none>})"
fi

# --- Must-6(c)/(d)/(f) (docs/specs/guard-evasion-gates.md): verify-guard-integrity.sh (spec-amend/
# stash-escape) を round-log 走査に頼らず in-place で直接実行する (collapsed-loop-guard.sh の
# 直接起動パターンを踏襲)。ここで検出した POLICY VIOLATION は quarantine waiver の対象外
# (is_gate_waived を一切呼ばない — 「waive 不能」の anti-accident invariant をこの経路自体で保証する)。
guard_integrity_script="$repository_root/scripts/verify-guard-integrity.sh"
if [ -f "$guard_integrity_script" ]; then
  guard_integrity_output="$(bash "$guard_integrity_script" --evidence-dir "$evidence_dir" 2>&1)"
  guard_integrity_exit=$?
  if [ "$guard_integrity_exit" -ne 0 ]; then
    block "status: complete ですが verify-guard-integrity.sh (spec-amend/stash-escape) が POLICY VIOLATION を検出しました (quarantine waiver は適用されません):
$guard_integrity_output"
  fi
fi

# --- Must-5: POLICY VIOLATION + quarantine waiver 検査 ---
is_gate_waived() {
  # $1 = 対象ゲート名 (例: verify-wiring.sh)  $2 = quarantine file path
  local target="$1" qfile="$2"
  [ -f "$qfile" ] || return 1
  local today records
  today="$(date -u +%F)"
  records="$(awk '
    function val(s){ sub(/^[^:]*:[[:space:]]*/,"",s); gsub(/^["\x27]|["\x27]$/,"",s); return s }
    function flush() {
      if (gate != "") print gate "\t" expires "\t" sub_verif
      gate=""; expires=""; sub_verif=""
    }
    /^[[:space:]]*-[[:space:]]*gate:/ { flush(); gate=val($0) }
    /^[[:space:]]{2,}expires_at:/ { expires=val($0) }
    /^[[:space:]]{2,}substitute_verification:/ { sub_verif=val($0) }
    END { flush() }
  ' "$qfile")"
  [ -n "$records" ] || return 1
  local gate expires sub_verif
  while IFS=$'\t' read -r gate expires sub_verif; do
    [ -z "$gate" ] && continue
    case "$target" in
      *"$gate"*) : ;;
      *)
        case "$gate" in
          *"$target"*) : ;;
          *) continue ;;
        esac
        ;;
    esac
    [ -n "$expires" ] || continue
    [ -n "$sub_verif" ] || continue
    if [[ "$expires" > "$today" || "$expires" == "$today" ]]; then
      return 0
    fi
  done <<< "$records"
  return 1
}

violation_msg=""
shopt -s nullglob
for log in "$latest_round"/verify-*.log; do
  [ -f "$log" ] || continue
  grep -q "POLICY VIOLATION" "$log" 2>/dev/null || continue
  gate_name="$(basename "$log" .log).sh"
  # Must-6(f): verify-guard-integrity.sh の POLICY VIOLATION は waiver 対象外 (anti-accident
  # invariant)。この round-log 経路でも is_gate_waived を呼ばずに常に violation 扱いとする。
  if [ "$gate_name" = "verify-guard-integrity.sh" ] || ! is_gate_waived "$gate_name" "$quarantine_file"; then
    violation_msg="${violation_msg}
  - POLICY VIOLATION: $log (gate=$gate_name, waiver なし/期限切れ、または waive 不能ゲート)"
  fi
done
shopt -u nullglob

if [ -n "$violation_msg" ]; then
  block "status: complete ですが未 waive の POLICY VIOLATION が残っています:${violation_msg}"
fi

exit 0
