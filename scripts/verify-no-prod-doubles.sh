#!/usr/bin/env bash
# KIT_VERSION: 1.3.0
# agent-policy: 本番パスへの test double 混入を検出する。
# - ファイル名 (mock/stub/fake/dummy/spy.<ext>)
# - mocking library の import / 呼び出し (jest.mock, vi.mock, sinon, gomock, testify/mock,
#   mockery, unittest.mock, patch(, Mockito, mockk, Test.QuickCheck.Fake 等)
# - Haskell: 非 test の src/app に mock/stub/fake/dummy 識別子・モジュール
# 除外: テスト系ディレクトリ、generated/、ci/allowlist.yml の owner+expiry 付き有効エントリ。
set -euo pipefail

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root"

# 差分対象 (CI) か、引数で渡された単一ファイル (hook) か。
if [ "$#" -gt 0 ]; then
  changed="$1"
else
  base="${BASE_REF:-$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@refs/remotes/@@')}"
  [ -z "${base:-}" ] && base="origin/main"
  if git rev-parse --verify "$base" >/dev/null 2>&1; then
    changed="$(git diff --name-only --diff-filter=ACMRT "$base"...HEAD)"
  else
    changed="$(git diff --name-only --diff-filter=ACMRT HEAD~1 2>/dev/null || git ls-files)"
  fi
  if [ -z "$changed" ]; then
    # no committed diff vs base — fall back to working-tree changes so uncommitted/untracked
    # work is not vacuously passed (CI always has a committed diff, so this branch is CI-inert).
    changed="$(git diff --name-only --diff-filter=ACMRT HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null)"
  fi
fi

# テスト系ディレクトリは除外 (テストダブルは正当)。docs/config はコード拡張子で除外。
test_dir_re='(^|/)(test|tests|__tests__|spec|specs|fixtures|testdata|mocks?|stubs?|fakes?)(/|$)'
code_ext_re='\.(ts|tsx|js|jsx|mjs|cjs|go|php|py|rb|java|kt|kts|hs|rs|scala|swift|c|cc|cpp|h|hpp)$'
prod_changed="$(printf '%s\n' "$changed" | grep -Evi "$test_dir_re" | grep -Evi '(^|/)generated/' | grep -Ei "$code_ext_re" || true)"

# allowlist (owner+expiry 付き・期限内) のパスを除外。
allowlist_paths=""
if [ -f ci/allowlist.yml ]; then
  allowlist_paths="$(awk '
    /^[[:space:]]*-[[:space:]]*rule:/ {p=""; e=""}
    /^[[:space:]]*path:/ {sub(/^[^:]*:[[:space:]]*/,""); gsub(/"/,""); p=$0}
    /^[[:space:]]*expires_at:/ {sub(/^[^:]*:[[:space:]]*/,""); gsub(/"/,""); e=$0; if (p!="") print e"\t"p}
  ' ci/allowlist.yml)"
fi
today="$(date +%F)"
is_allowlisted() {
  local f="$1" line exp pat
  [ -z "$allowlist_paths" ] && return 1
  while IFS=$'\t' read -r exp pat; do
    [ -z "$pat" ] && continue
    # 期限切れは無効 (allowlist として効かない → 検出を通す)
    [ "$exp" \< "$today" ] && continue
    case "$f" in $pat) return 0 ;; esac
  done <<< "$allowlist_paths"
  return 1
}

name_hits=""
content_hits=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  is_allowlisted "$f" && continue
  case "$f" in
    *mock.ts|*mock.tsx|*mock.js|*mock.jsx|*stub.ts|*stub.js|*fake.ts|*fake.js|*dummy.ts|*dummy.js|*spy.ts|*spy.js| \
    *Mock.hs|*Stub.hs|*Fake.hs|*Dummy.hs|*mock.go|*stub.go|*fake.go|*mock.py|*stub.py|*fake.py|*mock.php|*stub.php)
      name_hits="${name_hits}${f}"$'\n' ;;
  esac
  if grep -nEi 'jest\.mock\(|vi\.mock\(|\bsinon\b|gomock|testify/mock|\bmockery\b|unittest\.mock|[^a-zA-Z]patch\(|\bMockito\b|\bmockk\b|createMock|jest\.fn\(\)\.mock' "$f" >/dev/null 2>&1; then
    content_hits="${content_hits}${f}: mocking-library usage"$'\n'
  fi
  # Haskell: 非 test の src/app に test double 識別子・モジュール
  case "$f" in
    *.hs)
      if grep -nEi '\b(mkMock|mockImpl|fakeImpl|stubImpl|dummyImpl)\b|^import .*\.(Mock|Stub|Fake|Dummy)\b|^module .*\.(Mock|Stub|Fake|Dummy)\b' "$f" >/dev/null 2>&1; then
        content_hits="${content_hits}${f}: haskell test-double identifier/module in production path"$'\n'
      fi ;;
  esac
done <<< "$prod_changed"

if [ -n "$name_hits" ] || [ -n "$content_hits" ]; then
  echo "POLICY VIOLATION: production-path test doubles detected." >&2
  [ -n "$name_hits" ] && { echo "Filename hits:" >&2; printf '%s' "$name_hits" >&2; }
  [ -n "$content_hits" ] && { echo "Content hits:" >&2; printf '%s' "$content_hits" >&2; }
  echo "許可するには ci/allowlist.yml に owner/reason/expires_at 付きで追記してください。" >&2
  exit 1
fi
echo "no-prod-doubles: OK"
