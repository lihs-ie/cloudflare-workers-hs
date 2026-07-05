#!/usr/bin/env bash
# KIT_VERSION: 1.3.0
# agent-policy: portable shell helpers for cross-platform (macOS darwin sandbox / Linux CI) smoke
# and probe execution (docs/specs/harness-campaign-fix2-6.md Must-19). Sourceable library —
# defines functions only, has **no side effects on source** (no top-level execution, no `set -e`
# applied to the caller's shell). shellcheck-clean.
#
# Motivation (native-trace ~14x / alpha-mind incidents): runtime-verifier smoke/probe steps called
# bare `timeout`/`curl` directly and broke with "command not found" on hosts where those commands
# are absent (darwin sandbox lacks GNU coreutils' `timeout`; some minimal images lack `curl`).
#
# Usage: source scripts/portable.sh; portable_timeout 30 some-cmd --flag; portable_http_probe "$url"
#
# portable_timeout <seconds> <cmd...>
#   Runs <cmd...> bounded by <seconds>. Resolution priority:
#     1. gtimeout (GNU coreutils, common on macOS via `brew install coreutils`)
#     2. timeout (GNU coreutils, standard on Linux)
#     3. perl `alarm()` fallback (perl is present on virtually all Unix hosts, including the
#        darwin sandbox that lacks GNU coreutils)
#   Exit status is the wrapped command's exit status (or perl's alarm-triggered termination status
#   in the fallback path — not guaranteed to be exactly 124 like GNU timeout, but the command is
#   reliably terminated at the deadline).
portable_timeout() {
  local seconds="$1"
  shift
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
    return $?
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
    return $?
  fi
  if command -v perl >/dev/null 2>&1; then
    perl -e 'my $s = shift @ARGV; alarm $s; exec @ARGV; exit 127;' "$seconds" "$@"
    return $?
  fi
  echo "portable_timeout: no gtimeout/timeout/perl available -- running WITHOUT a timeout" >&2
  "$@"
}

# portable_http_probe <url> [expected-status (既定 200)]
#   GET <url> and compare the HTTP status code to [expected-status]. Resolution priority:
#     1. curl
#     2. wget
#     3. python3 (urllib.request)
#   Returns 0 if the status matches, 1 if it doesn't match or no probing tool is available.
portable_http_probe() {
  local url="$1" expected_status="${2:-200}" actual_status=""
  if command -v curl >/dev/null 2>&1; then
    actual_status="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"
  elif command -v wget >/dev/null 2>&1; then
    actual_status="$(wget -q -S -O /dev/null "$url" 2>&1 | awk '/^  HTTP\// {print $2; exit}')"
  elif command -v python3 >/dev/null 2>&1; then
    actual_status="$(python3 -c '
import sys, urllib.request, urllib.error
url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=10) as r:
        print(r.status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception:
    print("")
' "$url" 2>/dev/null)"
  else
    echo "portable_http_probe: no curl/wget/python3 available" >&2
    return 1
  fi
  [ -n "$actual_status" ] || return 1
  [ "$actual_status" = "$expected_status" ]
}
