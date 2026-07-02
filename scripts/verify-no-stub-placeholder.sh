#!/usr/bin/env bash
# KIT_VERSION: 1.1.0
# agent-policy: 本番経路に残った高シグナルな placeholder stub を検出する。
# 「関数は実装したが呼び出し側の placeholder を置換し忘れる」未配線を、ファイル共変更検査
# (verify-wiring.sh) でも no-prod-doubles でも捕捉できないため、明示マーカーで補足する。
# 検出するのは *高シグナル* なものに限る (bare [] / Nothing / undefined のような頻出値は
# false positive が多いので対象外。それらは runtime-verifier の実行 assert で捕まえる)。
#   - servant/Haskell:  throwError err501 / notImplemented
#   - Rust:             todo!() / unimplemented!()
#   - Go:               panic("not implemented")
#   - Python:           raise NotImplementedError
#   - TS/PHP/Java:      throw new Error("not implemented") 等
#   - 共通マーカー:      STUB: / PLACEHOLDER: / WIRE-ME / TODO(wire)
# テスト系ディレクトリは除外。CI では diff、hook では引数の単一ファイルを対象にする。
set -euo pipefail

repository_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repository_root"

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

test_dir_re='(^|/)(test|tests|__tests__|spec|specs|fixtures|testdata|mocks?|stubs?|fakes?)(/|$)'
code_ext_re='\.(ts|tsx|js|jsx|mjs|cjs|go|php|py|rb|java|kt|kts|hs|rs|scala|swift|c|cc|cpp|h|hpp)$'
prod_changed="$(printf '%s\n' "$changed" | grep -Evi "$test_dir_re" | grep -Evi '(^|/)generated/' | grep -Ei "$code_ext_re" || true)"

# 高シグナル placeholder マーカー。値そのもの ([] / Nothing 等) は対象にしない。
placeholder_re='throwError[[:space:]]+err501|\bnotImplemented\b|\bunimplemented![[:space:]]*\(|\btodo![[:space:]]*\(|panic\([[:space:]]*["'\''`][^"'\''`]*not[[:space:]]+implemented|NotImplementedError|throw[[:space:]]+new[[:space:]]+Error\([[:space:]]*["'\''`][^"'\''`]*not[[:space:]]+implemented|\bSTUB:|\bPLACEHOLDER:|\bWIRE[-[:space:]]?ME\b|TODO\([[:space:]]*wire|TODO:[[:space:]]*wire|FIXME\([[:space:]]*wire|undefined[[:space:]]*--|error[[:space:]]+"[^"]*(not[[:space:]]+implemented|unimplemented|TODO)'

hits=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  out="$(grep -nEi "$placeholder_re" "$f" 2>/dev/null || true)"
  [ -n "$out" ] && hits="${hits}== $f ==
$out
"
done <<< "$prod_changed"

if [ -n "$hits" ]; then
  echo "POLICY VIOLATION: placeholder stub left in production path." >&2
  printf '%s' "$hits" >&2
  echo "実装関数の本体だけでなく、呼び出し側の placeholder を実呼び出しに置換してください (wire-first)。" >&2
  echo "意図的に未実装で残すなら ci/allowlist.yml に owner/reason/expires_at 付きで登録してください。" >&2
  exit 1
fi
echo "no-stub-placeholder: OK"
