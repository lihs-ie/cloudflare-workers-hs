#!/usr/bin/env bash
# KIT_VERSION: 1.3.0
# agent-policy: 最新 round の verifier 判定 JSON (.agent-evidence/round-<N>/*.json) が、
# 現在の git ツリー状態と一致するか (stale でないか) を検査する。done-evaluator が
# stale な旧 FAIL/PASS を裁量で棚上げする事故 (native-trace で頻発) を機械検査で潰す。
# 現在のツリー状態は evidence-stamp.sh を呼び出して得る (sha256 計算ロジックは二重実装しない)。
#
# 挙動:
#   (a) 最新 round-<N>/ 直下の *.json のうち tree_stamp が現在のツリー状態と不一致なものが
#       1 つ以上あれば、不一致ファイルを列挙して exit 1。
#   (b) 存在する全 *.json が一致すれば exit 0。
#   (c) evidence dir 配下に round-* ディレクトリが 1 つも無ければ (初回) exit 0。
#
# 使い方: verify-evidence-freshness.sh [--evidence-dir <dir>]  (既定: .agent-evidence)
set -euo pipefail

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

evidence_dir=".agent-evidence"

while [ $# -gt 0 ]; do
  case "$1" in
    --evidence-dir)
      evidence_dir="${2:-}"
      shift 2
      ;;
    --evidence-dir=*)
      evidence_dir="${1#--evidence-dir=}"
      shift
      ;;
    -*)
      echo "verify-evidence-freshness: unknown arg '$1'" >&2
      exit 1
      ;;
    *)
      evidence_dir="$1"
      shift
      ;;
  esac
done

if [ ! -d "$evidence_dir" ]; then
  echo "verify-evidence-freshness: evidence dir not found: $evidence_dir (OK — first run)"
  exit 0
fi

# 最も番号の大きい round-<N>/ を最新 round とする。
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

if [ -z "$latest_round" ]; then
  echo "verify-evidence-freshness: no round-* directories under $evidence_dir (OK — first run)"
  exit 0
fi

shopt -s nullglob
json_files=("$latest_round"/*.json)
shopt -u nullglob

if [ "${#json_files[@]}" -eq 0 ]; then
  echo "verify-evidence-freshness: no *.json under $latest_round (OK — nothing to compare)"
  exit 0
fi

current_stamp="$(bash "$script_dir/evidence-stamp.sh")"

json_field() {
  # $1 = json string (from stdin var) | $2 = jq filter path (.git_sha / .dirty_diff_hash)
  local json="$1" filter="$2"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r "$filter // \"\"" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
except Exception:
    print('')
    sys.exit(0)
path = '$filter'.lstrip('.').split('.')
for p in path:
    if isinstance(data, dict):
        data = data.get(p)
    else:
        data = None
        break
print(data if isinstance(data, str) else '')
" <<< "$json"
  else
    echo "verify-evidence-freshness: WARNING: neither jq nor python3 found" >&2
    echo ""
  fi
}

current_git_sha="$(json_field "$current_stamp" '.git_sha')"
current_dirty_hash="$(json_field "$current_stamp" '.dirty_diff_hash')"

mismatched=""
for f in "${json_files[@]}"; do
  file_json="$(cat "$f")"
  file_git_sha="$(json_field "$file_json" '.tree_stamp.git_sha')"
  file_dirty_hash="$(json_field "$file_json" '.tree_stamp.dirty_diff_hash')"
  if [ -z "$file_git_sha" ] && [ -z "$file_dirty_hash" ]; then
    mismatched="${mismatched}  - $f: tree_stamp field missing\n"
    continue
  fi
  if [ "$file_git_sha" != "$current_git_sha" ] || [ "$file_dirty_hash" != "$current_dirty_hash" ]; then
    mismatched="${mismatched}  - $f: tree_stamp.git_sha='$file_git_sha' (current='$current_git_sha') tree_stamp.dirty_diff_hash='$file_dirty_hash' (current='$current_dirty_hash')\n"
  fi
done

if [ -n "$mismatched" ]; then
  echo "STALE EVIDENCE: $latest_round contains artifacts stamped to a different tree state:" >&2
  printf '%b' "$mismatched" >&2
  echo "該当 verifier を現在のツリーで再実行してください (done-evaluator が stale を裁量で棚上げすることは禁止)。" >&2
  exit 1
fi

echo "verify-evidence-freshness: OK ($latest_round matches current tree state)"
exit 0
