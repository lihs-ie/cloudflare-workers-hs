#!/usr/bin/env bash
# KIT_VERSION: 1.1.0
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
# 出力形式: "<phase>\t<failure_class|__ABSENT__>\t<target_test|__NOTARGET__>" per entry。
# phase 欠落は __NOPHASE__。target_test 欠落・空文字は __NOTARGET__。
if command -v jq >/dev/null 2>&1; then
  rows="$(jq -r '
    .iterations[]
    | [
        (.phase // "__NOPHASE__"),
        (.failure_class // "__ABSENT__"),
        ((.target_test // "") as $t | if $t == "" then "__NOTARGET__" else $t end)
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
    print(f'{phase}\t{fc}\t{tt}')
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
while IFS=$'\t' read -r phase cls tt; do
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
