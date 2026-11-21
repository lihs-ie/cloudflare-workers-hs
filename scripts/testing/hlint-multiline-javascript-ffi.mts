import { readFileSync } from 'node:fs';
import { command, runCli } from './Support/cli.mts';

const ffi = /\bforeign\s+import\s+javascript\b/;
const delimiter = '"""';

export function maskMultilineJavaScriptFfi(source: string): string {
  let state: 'haskell' | 'declaration' | 'javascript' = 'haskell';
  return (source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [])
    .map((line) => {
      const content = line.replace(/[\r\n]+$/, '');
      const newline = line.slice(content.length);

      if (state === 'haskell' && ffi.test(content)) {
        state = 'declaration';
      }

      if (state === 'javascript') {
        const closing = content.indexOf(delimiter);
        if (closing === -1) {
          return ' '.repeat(content.length) + newline;
        }

        state = 'haskell';
        const end = closing + delimiter.length;
        return ' '.repeat(end) + content.slice(end) + newline;
      }

      if (state === 'declaration') {
        const opening = content.indexOf(delimiter);
        if (opening === -1) {
          return line;
        }

        const closing = content.indexOf(delimiter, opening + delimiter.length);
        const end = closing === -1 ? content.length : closing + delimiter.length;
        state = closing === -1 ? 'javascript' : 'haskell';
        return (content.slice(0, opening) + '""').padEnd(end) + content.slice(end) + newline;
      }

      return line;
    })
    .join('');
}

runCli(import.meta.url, () => {
  const result = command([process.env.HLINT_REAL || 'hlint', ...process.argv.slice(2), '-'], {
    input: maskMultilineJavaScriptFfi(readFileSync(0, 'utf8')),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  return result.code;
});
