#!/usr/bin/env bash
# KIT_VERSION: 1.3.0
# agent-policy: iterations.json の failure_class を検証する。
# スキーマ (implementer.md §iterations.json が正本):
#   - 各 entry は phase (red|green|refactor|pivot) 必須
#   - phase=red   → failure_class 必須 (5 enum)
#   - phase=green / refactor → failure_class 禁止 (green は失敗ではない —
#     混入すると collapsed-loop 窓を汚染し、健全な red→green 収束を誤検知する)
#   - phase=pivot → failure_class 任意 (書くなら 5 enum)
# 判定:
#   - phase 欠落 / 未知 phase / enum 違反 / green・refactor に failure_class → exit 1
#   - collapsed loop (phase=red の末尾 3 entries が同一 failure_class **かつ同一 target_test**)
#     → exit 2 (red のみを数える。緑や pivot を挟んでも red 窓はリセットされない)。
#     異なる target_test への red は healthy triangulation (異なる挙動を各 1 回ずつ検証中) であり
#     collapsed loop ではない。窓内 (末尾 3 red) のいずれかの entry で target_test が欠落している
#     場合のみ、判定材料が無いため保守的に failure_class のみでの従来判定にフォールバックする。
#   - file 未存在 → exit 0 (初回前)
#   - Must-7 (UTC タイムスタンプ規律): started_at を持つ各 entry について:
#     - 未来時刻: started_at > 現在UTC + 5分 → exit 1 ("future" を含むメッセージ)
#     - 逆行: started_at を持つ entry が、配列順で直前の started_at を持つ entry の値より前
#       → exit 1 ("regress"/"逆行" を含むメッセージ)
#     GNU date (date -u -d) / BSD date (date -u -j -f) 両対応
#     (tests/run-shell-tests.sh の iso8601_seconds_ago と同じ移植パターン)。
#   - 正常 → exit 0
# 使い方: verify-failure-class.sh [path/to/iterations.json]
set -euo pipefail

VALID_CLASSES="product test-oracle harness-env flaky wiring-integration"
VALID_PHASES="red green refactor pivot"

target="${1:-.agent-evidence/iterations.json}"

if [ ! -f "$target" ]; then
  echo "verify-failure-class: $target not found (OK — first run)" >&2
  exit 0
fi

# JSON parsing: jq preferred, python3 fallback
# 出力形式: "<phase>\t<failure_class|__ABSENT__>\t<target_test|__NOTARGET__>\t<started_at|__NOSTART__>" per entry。
# phase 欠落は __NOPHASE__。target_test 欠落・空文字は __NOTARGET__。started_at 欠落は __NOSTART__。
if command -v jq >/dev/null 2>&1; then
  rows="$(jq -r '
    .iterations[]
    | [
        (.phase // "__NOPHASE__"),
        (.failure_class // "__ABSENT__"),
        ((.target_test // "") as $t | if $t == "" then "__NOTARGET__" else $t end),
        ((.started_at // "") as $s | if $s == "" then "__NOSTART__" else $s end)
      ]
    | @tsv
  ' "$target" 2>/dev/null)"
elif command -v python3 >/dev/null 2>&1; then
  rows="$(python3 -c "
import json
data = json.load(open('$target'))
for i in data.get('iterations', []):
    phase = i.get('phase') or '__NOPHASE__'
    fc = i.get('failure_class') or '__ABSENT__'
    tt = i.get('target_test') or '__NOTARGET__'
    st = i.get('started_at') or '__NOSTART__'
    print(f'{phase}\t{fc}\t{tt}\t{st}')
" 2>/dev/null)"
else
  echo "verify-failure-class: WARNING: neither jq nor python3 found; skipping check" >&2
  exit 0
fi

if [ -z "$rows" ]; then
  echo "verify-failure-class: ERROR: no iteration entries found (empty or unparsable)" >&2
  exit 1
fi

in_list() {
  local needle="$1" haystack="$2" item
  for item in $haystack; do
    [ "$needle" = "$item" ] && return 0
  done
  return 1
}

red_classes=""
red_targets=""
while IFS=$'\t' read -r phase cls tt st; do
  if [ "$phase" = "__NOPHASE__" ]; then
    echo "verify-failure-class: ERROR: phase field absent in one or more iterations (valid: $VALID_PHASES)" >&2
    exit 1
  fi
  if ! in_list "$phase" "$VALID_PHASES"; then
    echo "verify-failure-class: ERROR: unknown phase '$phase' (valid: $VALID_PHASES)" >&2
    exit 1
  fi
  case "$phase" in
    red)
      if [ "$cls" = "__ABSENT__" ]; then
        echo "verify-failure-class: ERROR: failure_class required on phase=red" >&2
        exit 1
      fi
      if ! in_list "$cls" "$VALID_CLASSES"; then
        echo "verify-failure-class: ERROR: unknown failure_class '$cls' (valid: $VALID_CLASSES)" >&2
        exit 1
      fi
      red_classes="${red_classes}${cls}"$'\n'
      red_targets="${red_targets}${tt}"$'\n'
      ;;
    green|refactor)
      if [ "$cls" != "__ABSENT__" ]; then
        echo "verify-failure-class: ERROR: failure_class forbidden on phase=$phase (pollutes collapsed-loop window)" >&2
        exit 1
      fi
      ;;
    pivot)
      if [ "$cls" != "__ABSENT__" ] && ! in_list "$cls" "$VALID_CLASSES"; then
        echo "verify-failure-class: ERROR: unknown failure_class '$cls' (valid: $VALID_CLASSES)" >&2
        exit 1
      fi
      ;;
  esac
done <<< "$rows"

# --- Must-7: UTC タイムスタンプ規律 (未来時刻 / 逆行) ---
parse_iso8601_epoch() {
  # GNU date / BSD date 両対応 (agent-time-budget.sh の parse_iso8601_epoch と同じ移植パターン)。
  local iso="$1" epoch=""
  epoch="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null)" && { printf '%s' "$epoch"; return 0; }
  epoch="$(date -u -d "$iso" +%s 2>/dev/null)" && { printf '%s' "$epoch"; return 0; }
  return 1
}

now_epoch="$(date -u +%s)"
future_threshold_epoch=$((now_epoch + 300))  # now + 5min

prev_started_epoch=""
prev_started_display=""
while IFS=$'\t' read -r phase cls tt st; do
  [ "$st" = "__NOSTART__" ] && continue
  [ -z "$st" ] && continue
  st_epoch="$(parse_iso8601_epoch "$st")" || st_epoch=""
  [ -z "$st_epoch" ] && continue   # parse 不能な値は他検査 (schema) に委ね、ここでは無視

  if [ "$st_epoch" -gt "$future_threshold_epoch" ]; then
    echo "verify-failure-class: ERROR: started_at '$st' is in the future (exceeds now+5min; possible local-time-written-as-Z mistake)" >&2
    exit 1
  fi

  if [ -n "$prev_started_epoch" ] && [ "$st_epoch" -lt "$prev_started_epoch" ]; then
    echo "verify-failure-class: ERROR: started_at '$st' regresses (逆行) — earlier than previous entry's started_at '$prev_started_display' (iterations[] は配列順に単調増加している必要がある)" >&2
    exit 1
  fi

  prev_started_epoch="$st_epoch"
  prev_started_display="$st"
done <<< "$rows"

# Collapsed loop: phase=red の末尾 3 entries が全て同一 failure_class かつ同一 target_test。
# target_test が窓内のいずれかで欠落している場合は判定材料が無いため、
# 保守的に failure_class のみでの従来判定にフォールバックする。
red_total=0
[ -n "$red_classes" ] && red_total=$(printf '%s' "$red_classes" | wc -l | tr -d ' ')
if [ "$red_total" -ge 3 ]; then
  last3_classes=$(printf '%s' "$red_classes" | tail -3)
  last3_targets=$(printf '%s' "$red_targets" | tail -3)
  uniq_class_count=$(echo "$last3_classes" | sort -u | wc -l | tr -d ' ')
  if [ "$uniq_class_count" -eq 1 ]; then
    has_missing_target=0
    while IFS= read -r t; do
      [ "$t" = "__NOTARGET__" ] && has_missing_target=1
    done <<< "$last3_targets"
    last_cls=$(echo "$last3_classes" | head -1)
    if [ "$has_missing_target" -eq 1 ]; then
      echo "verify-failure-class: ERROR: collapsed loop detected — last 3 red iterations all have failure_class='$last_cls' (target_test missing on one or more entries; conservative fallback to class-only judgement)" >&2
      exit 2
    fi
    uniq_target_count=$(echo "$last3_targets" | sort -u | wc -l | tr -d ' ')
    if [ "$uniq_target_count" -eq 1 ]; then
      last_tt=$(echo "$last3_targets" | head -1)
      echo "verify-failure-class: ERROR: collapsed loop detected — last 3 red iterations all have failure_class='$last_cls' and target_test='$last_tt'" >&2
      exit 2
    fi
  fi
fi

echo "verify-failure-class: OK"
exit 0
