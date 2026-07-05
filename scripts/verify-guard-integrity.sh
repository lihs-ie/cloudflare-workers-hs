#!/usr/bin/env bash
# KIT_VERSION: 1.3.0
# agent-policy: proven-done の完了主張が実際に迂回された経路のうち spec-amend (無断での spec 書換) と
# stash-escape (git stash によるタスク対象ファイルの隠蔽) を決定論的に検出する
# (docs/specs/guard-evasion-gates.md Must-2/Must-3/Must-4)。`.active` tamper 検出 (Must-5) は別スクリプト
# (scripts/agent-time-budget.sh) が担当する。
#
# 使い方:
#   verify-guard-integrity.sh [--evidence-dir <dir>] [--specs-dir <dir>]
#     spec-amend サブチェック (Must-2) + stash-escape サブチェック (Must-4) を順に実行し、
#     どちらかが POLICY VIOLATION なら非ゼロ終了、両方 pass/非対象なら exit 0。
#     既定: --evidence-dir .agent-evidence  --specs-dir docs/specs
#   verify-guard-integrity.sh --record-stash-baseline [--evidence-dir <dir>]
#     Step-0-simulation: 現在の `git stash list` の全行を <evidence-dir>/stash-baseline.txt に
#     そのまま記録する (Must-3)。実際の proven-done Step 0 からのこのモードの呼び出し配線は P4 の
#     スコープ — 本スクリプト自体はこのパケット (P12) 時点では意図的にどの entrypoint からも
#     未配線 (--evidence-dir 経由の standalone 実行のみ)。
#
# spec-amend (Must-2): <evidence-dir>/.active の `task=` から `<specs-dir>/<task>.md` を特定し、
#   その sha256 を `.active` の `spec_sha256=` スタンプと比較する。
#   (a) スタンプ未記録 → 非対象 exit 0
#   (b) 一致 → exit 0
#   (c) 不一致 かつ <evidence-dir>/oracle-change-approval.json が非存在、または存在しても
#       new_spec_sha256 が現在ハッシュと不一致 → POLICY VIOLATION
#   (d) 不一致だが有効な oracle-change-approval.json (new_spec_sha256 が現在ハッシュと一致) がある
#       → exit 0 (承認済み amend)
#
# stash-escape (Must-4, baseline は Must-3): <evidence-dir>/stash-baseline.txt 記録後に追加された
#   stash entry ごとに `git stash show --name-only` でタッチしたファイルを取り、
#   <evidence-dir>/wiring-map.json の changes[].file、または現在のタスク diff
#   (committed(base...HEAD) ∪ working-tree — scripts/verify-wiring.sh と同じ union 規約。
#   BASE_REF 未設定なら committed∪staged∪unstaged∪untracked、明示時は committed のみ) と
#   1 件でも重複するかを判定する。baseline 後の新規 stash 無し/重複なし → exit 0、
#   重複あり → POLICY VIOLATION (該当 stash ref とファイルを明示)。
#   新規 stash の判定は `stash@{N}: ` の index prefix を取り除いた正規化テキストの集合比較で行う
#   (baseline 記録後に stash が push/pop されて index がシフトしても誤検知しないため)。
set -uo pipefail

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root" 2>/dev/null || true

evidence_dir=".agent-evidence"
specs_dir="docs/specs"
mode="check"

while [ $# -gt 0 ]; do
  case "$1" in
    --evidence-dir) evidence_dir="${2:-}"; shift 2 ;;
    --evidence-dir=*) evidence_dir="${1#--evidence-dir=}"; shift ;;
    --specs-dir) specs_dir="${2:-}"; shift 2 ;;
    --specs-dir=*) specs_dir="${1#--specs-dir=}"; shift ;;
    --record-stash-baseline) mode="record-stash-baseline"; shift ;;
    *) shift ;;
  esac
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

json_field() {
  # $1 = json string  $2 = jq filter (例: '.new_spec_sha256')。jq 優先 + python3 fallback
  # (scripts/agent-time-budget.sh の json_field と同じ方式)。
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

json_array_field() {
  # $1 = json string  $2 = 配列キー (例: changes)  $3 = 各要素のフィールド名 (例: file)
  local json="$1" key="$2" field="$3"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r --arg k "$key" --arg f "$field" '(.[$k] // [])[] | .[$f] // empty' 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
for item in (data.get('$key') or []):
    if isinstance(item, dict):
        v = item.get('$field')
        if isinstance(v, str):
            print(v)
" <<< "$json" 2>/dev/null
  fi
}

if [ "$mode" = "record-stash-baseline" ]; then
  mkdir -p "$evidence_dir"
  git stash list > "$evidence_dir/stash-baseline.txt" 2>/dev/null || : > "$evidence_dir/stash-baseline.txt"
  echo "verify-guard-integrity: stash baseline recorded ($evidence_dir/stash-baseline.txt)"
  exit 0
fi

violations=""

# --- spec-amend (Must-2) ---
check_spec_amend() {
  local active_file="$evidence_dir/.active"
  if [ ! -f "$active_file" ]; then
    echo "verify-guard-integrity (spec-amend): .active 不在 (非対象)"
    return 0
  fi
  local task stamped
  task="$(grep '^task=' "$active_file" 2>/dev/null | head -1 | cut -d'=' -f2-)"
  stamped="$(grep '^spec_sha256=' "$active_file" 2>/dev/null | head -1 | cut -d'=' -f2-)"
  if [ -z "$stamped" ]; then
    echo "verify-guard-integrity (spec-amend): spec_sha256= 未記録 (lane 未確定、非対象)"
    return 0
  fi
  if [ -z "$task" ]; then
    echo "verify-guard-integrity (spec-amend): task= 不在 (非対象)" >&2
    return 0
  fi
  local spec_file="$specs_dir/$task.md"
  if [ ! -f "$spec_file" ]; then
    echo "verify-guard-integrity (spec-amend): spec ファイル不在 ($spec_file、非対象)" >&2
    return 0
  fi
  local current
  current="$(sha256_of "$spec_file")"
  if [ "$current" = "$stamped" ]; then
    echo "verify-guard-integrity (spec-amend): OK ($spec_file の sha256 が一致)"
    return 0
  fi
  local approval_file="$evidence_dir/oracle-change-approval.json"
  if [ -f "$approval_file" ]; then
    local new_hash
    new_hash="$(json_field "$(cat "$approval_file")" '.new_spec_sha256')"
    if [ -n "$new_hash" ] && [ "$new_hash" = "$current" ]; then
      echo "verify-guard-integrity (spec-amend): OK (承認済み amend, $spec_file, oracle-change-approval.json)"
      return 0
    fi
  fi
  violations="${violations}POLICY VIOLATION (spec-amend): $spec_file の現在の sha256 が $active_file の spec_sha256= スタンプと不一致、かつ有効な oracle-change-approval.json (new_spec_sha256 が現在ハッシュと一致するもの) が見つかりません。無断の spec 書き換えでなければ Step 6.5 の AskUserQuestion 経路で承認を取得してください。
"
  return 1
}

# --- stash-escape (Must-4, baseline は Must-3) ---
compute_task_touched_files() {
  local wiring_map="$evidence_dir/wiring-map.json"
  local from_wiring=""
  if [ -f "$wiring_map" ]; then
    from_wiring="$(json_array_field "$(cat "$wiring_map")" 'changes' 'file')"
  fi

  local base_ref_was_set=0
  [ -n "${BASE_REF:-}" ] && base_ref_was_set=1
  local base="${BASE_REF:-$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@refs/remotes/@@')}"
  [ -z "${base:-}" ] && base="origin/main"
  local committed=""
  if git rev-parse --verify "$base" >/dev/null 2>&1; then
    committed="$(git diff --name-only --diff-filter=ACMRT "$base"...HEAD 2>/dev/null || true)"
  else
    committed="$(git diff --name-only --diff-filter=ACMRT HEAD~1 2>/dev/null || true)"
  fi

  local changed
  if [ "$base_ref_was_set" -eq 1 ]; then
    changed="$committed"
  else
    local working_tree
    working_tree="$(
      { git diff --name-only --diff-filter=ACMRT HEAD 2>/dev/null || true
        git diff --name-only --diff-filter=ACMRT --cached 2>/dev/null || true
        git ls-files --others --exclude-standard 2>/dev/null || true
      }
    )"
    changed="$(printf '%s\n%s\n' "$committed" "$working_tree" | sed '/^$/d' | sort -u)"
  fi

  printf '%s\n%s\n' "$from_wiring" "$changed" | sed '/^$/d' | sort -u
}

check_stash_escape() {
  local baseline_file="$evidence_dir/stash-baseline.txt"
  if [ ! -f "$baseline_file" ]; then
    echo "verify-guard-integrity (stash-escape): stash baseline 未記録 (非対象)"
    return 0
  fi
  local current_lines
  current_lines="$(git stash list 2>/dev/null || true)"
  if [ -z "$current_lines" ]; then
    echo "verify-guard-integrity (stash-escape): OK (stash 無し)"
    return 0
  fi

  local baseline_norm
  baseline_norm="$(sed -E 's/^stash@\{[0-9]+\}: //' "$baseline_file" 2>/dev/null || true)"

  local touched_files
  touched_files="$(compute_task_touched_files)"

  local violated=0
  local report=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local stash_idx norm_line
    stash_idx="$(printf '%s' "$line" | sed -E 's/^stash@\{([0-9]+)\}.*/\1/')"
    norm_line="$(printf '%s' "$line" | sed -E 's/^stash@\{[0-9]+\}: //')"
    if printf '%s\n' "$baseline_norm" | grep -qxF "$norm_line"; then
      continue
    fi
    # baseline 記録後に追加された stash
    local stash_ref="stash@{${stash_idx:-0}}"
    local stash_files overlap
    stash_files="$(git stash show --name-only "$stash_ref" 2>/dev/null || true)"
    overlap=""
    while IFS= read -r sf; do
      [ -z "$sf" ] && continue
      if printf '%s\n' "$touched_files" | grep -qxF "$sf"; then
        overlap="$sf"
        break
      fi
    done <<< "$stash_files"
    if [ -n "$overlap" ]; then
      violated=1
      report="${report}POLICY VIOLATION (stash-escape): $stash_ref がタスク対象ファイル '$overlap' をタッチしています (baseline 記録後に追加された stash)。無関係な作業と分離し、タスク対象ファイルを stash に残さないでください。
"
    fi
  done <<< "$current_lines"

  if [ "$violated" -eq 1 ]; then
    violations="${violations}${report}"
    return 1
  fi
  echo "verify-guard-integrity (stash-escape): OK (baseline 後の新規 stash はタスク対象ファイルと無関係)"
  return 0
}

check_spec_amend || true
check_stash_escape || true

if [ -n "$violations" ]; then
  printf '%s' "$violations" >&2
  exit 1
fi

echo "verify-guard-integrity: OK (spec-amend + stash-escape)"
exit 0
