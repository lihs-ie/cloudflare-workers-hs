#!/usr/bin/env bash
# agent-policy: ci/allowlist.yml の期限切れエントリを検出して fail する。
# 無期限 allowlist は数週間で抜け穴になるため、expires_at 必須 + 期限切れは CI を落とす。
set -euo pipefail

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root"

f="ci/allowlist.yml"
[ -f "$f" ] || { echo "verify-allowlist-expiry: $f not found (OK)"; exit 0; }

today="$(date +%F)"
expired="$(awk -v today="$today" '
  function val(s){ sub(/^[^:]*:[[:space:]]*/,"",s); gsub(/^["\x27]|["\x27]$/,"",s); return s }
  /^[[:space:]]*-[[:space:]]*rule:/ { rule=val($0); path=""; expiry="" }
  /^[[:space:]]*path:/ { path=val($0) }
  /^[[:space:]]*expires_at:/ { expiry=val($0); if (expiry=="" || expiry < today) print "  " rule " (" path ") expires_at=" (expiry==""?"<MISSING>":expiry) }
' "$f")"

if [ -n "$expired" ]; then
  echo "POLICY VIOLATION: expired or undated allowlist entries:" >&2
  printf '%s\n' "$expired" >&2
  echo "ci/allowlist.yml を棚卸しし、不要なら削除、必要なら expires_at を更新してください。" >&2
  exit 1
fi
echo "verify-allowlist-expiry: OK"
