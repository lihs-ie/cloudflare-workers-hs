export const shellToolDoubles = {
  'tools/wasm32-wasi-cabal':
    '{ printf \'cabal\'; printf \' <%s>\' "$@"; printf \'\\n\'; } >> "$CALL_LOG"\nif [ "$1" = build ] && [ "${FAIL_BUILD:-0}" = 1 ]; then exit 42; fi\nif [ "$1" = list-bin ] && [ "${FAIL_STAGE:-}" = list-bin ]; then exit 43; fi\nif [ "$1" = list-bin ]; then echo /work/binary.wasm; fi\n',
  'tools/wasm32-wasi-ghc': 'echo /work/lib\n',
  'lib/post-link.mjs':
    '{ printf \'post-link\'; printf \' <%s>\' "$@"; printf \'\\n\'; } >> "$CALL_LOG"\n[ "${FAIL_STAGE:-}" != post-link ] || exit 44\n[ "$1" = --input ] && [ "$3" = --output ]\nprintf fixture > "$4"\n',
  'base/node':
    '{ printf \'node\'; printf \' <%s>\' "$@"; printf \'\\n\'; } >> "$CALL_LOG"\nif [ "$1" = --input-type=module ]; then operation="$3"; else operation="$2"; fi\ncase "${FAIL_STAGE:-}:$operation" in\ncapture:*capture*) exit 45 ;;\nwrite:*write*) exit 46 ;;\nesac\n',
};
