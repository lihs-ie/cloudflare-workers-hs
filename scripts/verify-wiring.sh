#!/usr/bin/env bash
# agent-policy: wiring_manifest.yml に基づき「実装に対し配線が追随しているか」を検出する。
# 各 rule: 変更ファイルが `when` glob にマッチしたら、`require_one_of` のいずれかにも
# 変更ファイルがマッチしていなければ FAIL (未配線の疑い)。
# waiver: .agent-evidence/wiring-waivers.txt に rule id を 1 行書くと、その rule をスキップ
#         (= 配線不要の理由を証跡として残した、とみなす)。
# smoke は v1 では宣言のみ (実行しない)。
set -euo pipefail

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root"

manifest="wiring_manifest.yml"
if [ ! -f "$manifest" ]; then
  echo "verify-wiring: $manifest not found (skip)"; exit 0
fi

base="${BASE_REF:-$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@refs/remotes/@@')}"
[ -z "${base:-}" ] && base="origin/main"
if git rev-parse --verify "$base" >/dev/null 2>&1; then
  changed="$(git diff --name-only --diff-filter=ACMRT "$base"...HEAD)"
else
  changed="$(git diff --name-only --diff-filter=ACMRT HEAD~1 2>/dev/null || true)"
fi
[ -z "$changed" ] && { echo "verify-wiring: no changes (OK)"; exit 0; }

waivers=""
[ -f .agent-evidence/wiring-waivers.txt ] && waivers="$(cat .agent-evidence/wiring-waivers.txt)"

glob_to_regex() {
  local g="$1"
  g="${g//./\\.}"
  g="${g//\*\*/§§}"
  g="${g//\*/[^/]*}"
  g="${g//§§/.*}"
  printf '^%s$' "$g"
}
matches_any() { # $1=file  rest=globs
  local f="$1"; shift
  local g re
  for g in "$@"; do
    re="$(glob_to_regex "$g")"
    printf '%s' "$f" | grep -Eq "$re" && return 0
  done
  return 1
}

# manifest をフラットなレコードに変換 (constrained schema: rules: - id/when/require_one_of/reason/smoke)
records="$(awk '
  function val(s){ sub(/^[^:]*:[[:space:]]*/,"",s); gsub(/^["\x27]|["\x27]$/,"",s); return s }
  /^[[:space:]]*-[[:space:]]*id:/ { if(id!="") print "END"; id=val($0); print "RULE\t" id; sec=""; next }
  /^[[:space:]]*when:/ { print "WHEN\t" val($0); sec=""; next }
  /^[[:space:]]*require_one_of:/ { sec="req"; next }
  /^[[:space:]]*reason:/ { print "REASON\t" val($0); sec=""; next }
  /^[[:space:]]*smoke:/ { print "SMOKE\t" val($0); sec=""; next }
  /^[[:space:]]*-[[:space:]]/ { if(sec=="req"){ line=$0; sub(/^[[:space:]]*-[[:space:]]*/,"",line); gsub(/^["\x27]|["\x27]$/,"",line); print "REQ\t" line } next }
  END { if(id!="") print "END" }
' "$manifest")"

violations=""
declare -a reqs=()
rid=""; when=""; reason=""; smoke=""; triggered=0
flush_rule() {
  [ -z "$rid" ] && return
  if printf '%s\n' "$waivers" | grep -qx "$rid"; then
    echo "  rule '$rid': WAIVED (.agent-evidence/wiring-waivers.txt)"
    return
  fi
  # when にマッチした変更があるか
  local triggered_file="" f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if matches_any "$f" "$when"; then triggered_file="$f"; break; fi
  done <<< "$changed"
  if [ -z "$triggered_file" ]; then
    echo "  rule '$rid': not triggered"
    return
  fi
  # require_one_of のいずれかにマッチする変更があるか
  local satisfied=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if matches_any "$f" "${reqs[@]}"; then satisfied=1; break; fi
  done <<< "$changed"
  if [ "$satisfied" -eq 1 ]; then
    echo "  rule '$rid': OK (triggered by $triggered_file, wiring present)"
    [ -n "$smoke" ] && echo "    smoke declared (v1: not run): $smoke"
  else
    violations="${violations}- rule '$rid': '$triggered_file' を変更したが配線先が未更新。
    require one of: ${reqs[*]}
    reason: $reason
"
    [ -n "$smoke" ] && violations="${violations}    smoke (declared): $smoke
"
  fi
  return 0   # flush_rule の末尾が [ -n "$smoke" ] (smoke 無しで status 1) で終わると set -e が落ちるのを防ぐ
}

while IFS=$'\t' read -r tag v; do
  case "$tag" in
    RULE) flush_rule; rid="$v"; when=""; reason=""; smoke=""; reqs=() ;;
    WHEN) when="$v" ;;
    REQ)  reqs+=("$v") ;;
    REASON) reason="$v" ;;
    SMOKE) smoke="$v" ;;
    END) : ;;
  esac
done <<< "$records"
flush_rule

if [ -n "$violations" ]; then
  echo "POLICY VIOLATION: wiring not following implementation." >&2
  printf '%s' "$violations" >&2
  echo "配線が本当に不要なら、その rule id を .agent-evidence/wiring-waivers.txt に 1 行書いて理由を証跡化してください。" >&2
  exit 1
fi
echo "verify-wiring: OK"
