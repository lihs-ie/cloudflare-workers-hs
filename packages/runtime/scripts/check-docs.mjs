import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';
import { TSDocParser } from '@microsoft/tsdoc';

function children(node) {
  return Object.values(node).flatMap((value) => {
    if (Array.isArray(value)) {
      return value.filter((item) => item?.type);
    }

    return value?.type ? [value] : [];
  });
}
const nameOf = (node) =>
  node.id?.name ?? node.key?.name ?? node.key?.value ?? node.kind ?? node.type;
const members = new Set([
  'TSPropertySignature',
  'TSMethodSignature',
  'TSCallSignatureDeclaration',
  'TSConstructSignatureDeclaration',
  'TSIndexSignature',
]);

function returnedIdentifiers(body) {
  const returned = new Set();
  function visit(node) {
    if (node.type === 'ReturnStatement') {
      let expression = node.argument;
      while (expression?.type === 'TSAsExpression' || expression?.type === 'TSNonNullExpression') {
        expression = expression.expression;
      }

      if (expression?.type === 'Identifier') {
        returned.add(expression.name);
      }
    }

    if (node !== body && /Function|Class/.test(node.type)) {
      return;
    }

    for (const child of children(node)) {
      visit(child);
    }
  }

  if (body) {
    visit(body);
  }

  return returned;
}

export function checkSource(source, filename = 'input.ts') {
  const parsed = parseSync(filename, source);
  const issues = [];
  const report = (node, message) =>
    issues.push({ line: source.slice(0, node.start ?? 0).split('\n').length, message });
  for (const error of parsed.errors) {
    report({ start: error.labels?.[0]?.start }, `TypeScript syntax: ${error.message}`);
  }

  if (parsed.errors.length) {
    return issues;
  }

  const checked = new Set();
  const parser = new TSDocParser();
  function requireDoc(node, label, start = node.start) {
    if (checked.has(node)) {
      return;
    }

    checked.add(node);
    const comment = parsed.comments.findLast(
      (item) => item.end <= start && /^\s*$/.test(source.slice(item.end, start)),
    );
    if (!comment || !source.slice(comment.start, comment.end).startsWith('/**')) {
      report(node, `${label}: missing TSDoc`);
      return;
    }

    const result = parser.parseString(source.slice(comment.start, comment.end));
    for (const diagnostic of result.log.messages) {
      report(node, `${label}: ${diagnostic.messageId}: ${diagnostic.unformattedText}`);
    }
    const plainText = (part) =>
      `${part.text ?? part.decodedText ?? ''}${part.getChildNodes().map(plainText).join(' ')}`;
    const summary = plainText(result.docComment.summarySection).trim();
    if (!/[A-Za-z]{2}/.test(summary)) {
      report(node, `${label}: missing English summary description`);
    } else if (
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}]/u.test(summary)
    ) {
      report(node, `${label}: summary must use English prose`);
    }
  }
  function types(node, path) {
    if (!node) {
      return;
    }

    if (members.has(node.type)) {
      requireDoc(node, `${path}.${nameOf(node)}`);
    }
    for (const child of children(node)) {
      types(child, path);
    }
  }
  function classMembers(node, label) {
    for (const member of node.body.body) {
      if (
        member.accessibility === 'private' ||
        member.accessibility === 'protected' ||
        member.key?.type === 'PrivateIdentifier' ||
        member.type === 'StaticBlock'
      ) {
        continue;
      }

      requireDoc(member, `${label}.${nameOf(member)}`);
      types(member.typeAnnotation, label);
      types(member.value?.returnType, label);
      for (const parameter of member.value?.params ?? []) {
        types(parameter, label);
      }
    }
  }
  function declaration(node, start = node.start) {
    const label = String(nameOf(node));
    requireDoc(node, label, start);

    if (/Function/.test(node.type)) {
      // Every Oxc function declaration/expression has a params array, including ambient declarations.
      for (const parameter of node.params) {
        types(parameter, label);
      }
      types(node.returnType, label);
      const returned = returnedIdentifiers(node.body);
      for (const statement of node.body?.body ?? []) {
        if (statement.type === 'ClassDeclaration' && returned.has(statement.id?.name)) {
          classMembers(statement, label);
        }
      }
    } else if (node.type === 'ClassDeclaration') {
      classMembers(node, label);
    } else {
      types(node, label);
    }
  }
  const declarations = new Map(parsed.program.body.map((item) => [item.id?.name, item]));
  for (const item of parsed.program.body) {
    if (item.type === 'ExportNamedDeclaration' || item.type === 'ExportDefaultDeclaration') {
      if (item.declaration) {
        declaration(item.declaration, item.start);
      }
      for (const specifier of item.specifiers ?? []) {
        const target = declarations.get(specifier.local?.name);
        if (target) {
          declaration(target);
        }
      }
    }
  }
  return issues;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filenames = process.argv.slice(2);
  if (!filenames.length) {
    filenames.push(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
  }
  let count = 0;
  for (const filename of filenames) {
    const issues = checkSource(readFileSync(filename, 'utf8'), filename);
    for (const issue of issues) {
      console.error(`${filename}:${issue.line}: ${issue.message}`);
    }
    count += issues.length;
  }

  if (count) {
    process.exitCode = 1;
  } else {
    console.log('Public API TSDoc checks passed.');
  }
}
