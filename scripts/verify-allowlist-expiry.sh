#!/usr/bin/env bash
# KIT_VERSION: 1.3.0
# agent-policy: allowlist / quarantine の期限切れエントリを検出して fail する。
# 使い方: verify-allowlist-expiry.sh [--quarantine <file>]
set -euo pipefail

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root"

quarantine_file=""
if [ "${1:-}" = "--quarantine" ] && [ -n "${2:-}" ]; then
  quarantine_file="$2"
fi

check_expiry_file() {
  local f="$1"
  local label="$2"
  [ -f "$f" ] || { echo "$label: $f not found (OK)"; return 0; }

  local today
  today="$(date +%F)"
  local expired
  expired="$(awk -v today="$today" '
    function val(s){ sub(/^[^:]*:[[:space:]]*/,"",s); gsub(/^["\x27]|["\x27]$/,"",s); return s }
    function flush_gate() {
      if (gate_entry != "") {
        missing = ""
        if (gate_expiry == "" || gate_expiry < today) missing = missing " expires_at=" (gate_expiry==""?"<MISSING>":gate_expiry)
        if (gate_evidence_url == "") missing = missing " evidence_url=<MISSING>"
        if (gate_substitute_verification == "") missing = missing " substitute_verification=<MISSING>"
        if (gate_approved_by == "") missing = missing " approved_by=<MISSING>"
        if (missing != "") print "  gate:" gate_entry missing
      }
      gate_entry=""; gate_expiry=""; gate_evidence_url=""; gate_substitute_verification=""; gate_approved_by=""
    }
    /^[[:space:]]*-[[:space:]]*(rule|test):/ { flush_gate(); mode="legacy"; entry=val($0); path=""; expiry="" }
    /^[[:space:]]*-[[:space:]]*gate:/ { flush_gate(); mode="gate"; gate_entry=val($0) }
    /^[[:space:]]{2,}(path|test):/ { if (mode=="legacy") path=val($0) }
    mode=="gate" && /^[[:space:]]{2,}evidence_url:/ { gate_evidence_url=val($0) }
    mode=="gate" && /^[[:space:]]{2,}substitute_verification:/ { gate_substitute_verification=val($0) }
    mode=="gate" && /^[[:space:]]{2,}approved_by:/ { gate_approved_by=val($0) }
    /^[[:space:]]*expires_at:/ {
      expiry=val($0)
      if (mode=="gate") { gate_expiry=expiry }
      else if (mode=="legacy") { if (expiry=="" || expiry < today) print "  " entry " (" path ") expires_at=" (expiry==""?"<MISSING>":expiry) }
    }
    END { flush_gate() }
  ' "$f")"

  if [ -n "$expired" ]; then
    echo "POLICY VIOLATION: expired or undated entries in $f:" >&2
    printf '%s\n' "$expired" >&2
    echo "$f を棚卸しし、不要なら削除、必要なら expires_at を更新してください。" >&2
    return 1
  fi
  echo "$label: OK"
  return 0
}

exit_code=0

if [ -n "$quarantine_file" ]; then
  check_expiry_file "$quarantine_file" "verify-quarantine-expiry" || exit_code=1
else
  check_expiry_file "ci/allowlist.yml" "verify-allowlist-expiry" || exit_code=1
fi

exit $exit_code
