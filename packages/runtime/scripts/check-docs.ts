import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSync,
  visitorKeys,
  type Class,
  type Comment,
  type ExportDefaultDeclarationKind,
  type FunctionBody,
  type Program,
} from 'oxc-parser';
import { DocEscapedText, DocPlainText, TSDocParser, type DocNode } from '@microsoft/tsdoc';

interface AstNode {
  type: string;
  start: number;
}

interface Issue {
  line: number;
  message: string;
}

type PublicDeclaration = Program['body'][number] | ExportDefaultDeclarationKind;

type RequireDoc = (node: AstNode, label: string, start?: number) => void;

const typeMembers = new Set([
  'TSPropertySignature',
  'TSMethodSignature',
  'TSCallSignatureDeclaration',
  'TSConstructSignatureDeclaration',
  'TSIndexSignature',
]);

function property(node: object, key: string): unknown {
  return Reflect.get(node, key);
}

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'start' in value &&
    typeof value.start === 'number'
  );
}

function children(node: AstNode): AstNode[] {
  return (visitorKeys[node.type] ?? []).flatMap((key) => {
    const value = property(node, key);
    if (Array.isArray(value)) {
      return value.filter(isAstNode);
    }

    return isAstNode(value) ? [value] : [];
  });
}

function nameOf(node: AstNode): string {
  const identifier = property(node, 'id');
  const key = property(node, 'key');
  const identifierName = isAstNode(identifier) ? property(identifier, 'name') : undefined;
  const keyName = isAstNode(key) ? (property(key, 'name') ?? property(key, 'value')) : undefined;
  const name = identifierName ?? keyName ?? property(node, 'kind');
  return typeof name === 'string' ||
    typeof name === 'number' ||
    typeof name === 'boolean' ||
    typeof name === 'bigint' ||
    name instanceof RegExp
    ? String(name)
    : node.type;
}

function returnedIdentifiers(body: FunctionBody | null): Set<string> {
  const returned = new Set<string>();
  function visit(node: AstNode): void {
    if (node.type === 'ReturnStatement') {
      let expression = property(node, 'argument');
      while (
        isAstNode(expression) &&
        (expression.type === 'TSAsExpression' || expression.type === 'TSNonNullExpression')
      ) {
        expression = property(expression, 'expression');
      }

      if (isAstNode(expression) && expression.type === 'Identifier') {
        const name = property(expression, 'name');
        if (typeof name === 'string') {
          returned.add(name);
        }
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

function plainText(part: DocNode): string {
  const childrenText = part.getChildNodes().map(plainText).join(' ');

  if (part instanceof DocPlainText) {
    return part.text + childrenText;
  }

  if (part instanceof DocEscapedText) {
    return part.decodedText + childrenText;
  }

  return childrenText;
}

function checkTypes(node: AstNode | null | undefined, label: string, requireDoc: RequireDoc): void {
  if (!node) {
    return;
  }

  if (typeMembers.has(node.type)) {
    requireDoc(node, `${label}.${nameOf(node)}`);
  }

  for (const child of children(node)) {
    checkTypes(child, label, requireDoc);
  }
}

function checkClass(node: Class, label: string, requireDoc: RequireDoc): void {
  for (const member of node.body.body) {
    if (
      member.type === 'StaticBlock' ||
      ('accessibility' in member &&
        (member.accessibility === 'private' || member.accessibility === 'protected')) ||
      ('key' in member && member.key.type === 'PrivateIdentifier')
    ) {
      continue;
    }

    requireDoc(member, `${label}.${nameOf(member)}`);

    if ('typeAnnotation' in member) {
      checkTypes(member.typeAnnotation, label, requireDoc);
    }

    if ('value' in member && member.value && 'params' in member.value) {
      checkTypes(member.value.returnType, label, requireDoc);
      for (const parameter of member.value.params) {
        checkTypes(parameter, label, requireDoc);
      }
    }
  }
}

function checkDeclaration(
  node: PublicDeclaration,
  requireDoc: RequireDoc,
  start: number = node.start,
): void {
  const label = nameOf(node);
  requireDoc(node, label, start);

  if ('params' in node) {
    for (const parameter of node.params) {
      checkTypes(parameter, label, requireDoc);
    }

    checkTypes(node.returnType, label, requireDoc);
    const body = node.body;
    if (body?.type === 'BlockStatement') {
      const returned = returnedIdentifiers(body);
      for (const statement of body.body) {
        if (
          statement.type === 'ClassDeclaration' &&
          statement.id &&
          returned.has(statement.id.name)
        ) {
          checkClass(statement, label, requireDoc);
        }
      }
    }
  } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    checkClass(node, label, requireDoc);
  } else {
    checkTypes(node, label, requireDoc);
  }
}

function checkPublicDeclarations(program: Program, requireDoc: RequireDoc): void {
  const declarations = new Map<string, Program['body'][number]>();
  for (const node of program.body) {
    if ('id' in node && node.id && 'name' in node.id) {
      declarations.set(node.id.name, node);
    }
  }

  for (const node of program.body) {
    if (node.type === 'ExportDefaultDeclaration') {
      checkDeclaration(node.declaration, requireDoc, node.start);
      continue;
    }

    if (node.type !== 'ExportNamedDeclaration') {
      continue;
    }

    if (node.declaration) {
      checkDeclaration(node.declaration, requireDoc, node.start);
    }

    for (const { local } of node.specifiers) {
      if (local.type !== 'Identifier') {
        continue;
      }

      const target = declarations.get(local.name);
      if (target) {
        checkDeclaration(target, requireDoc);
      }
    }
  }
}

function docChecker(
  source: string,
  comments: readonly Comment[],
  report: (start: number, message: string) => void,
): RequireDoc {
  const checked = new Set<AstNode>();
  const parser = new TSDocParser();

  return (node, label, start = node.start) => {
    if (checked.has(node)) {
      return;
    }

    checked.add(node);
    const comment = comments.findLast(
      (item) => item.end <= start && /^\s*$/.test(source.slice(item.end, start)),
    );
    if (!comment || !source.slice(comment.start, comment.end).startsWith('/**')) {
      report(node.start, `${label}: missing TSDoc`);
      return;
    }

    const result = parser.parseString(source.slice(comment.start, comment.end));
    for (const diagnostic of result.log.messages) {
      report(node.start, `${label}: ${diagnostic.messageId}: ${diagnostic.unformattedText}`);
    }

    const summary = plainText(result.docComment.summarySection).trim();
    if (!/[A-Za-z]{2}/.test(summary)) {
      report(node.start, `${label}: missing English summary description`);
    } else if (
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}]/u.test(summary)
    ) {
      report(node.start, `${label}: summary must use English prose`);
    }
  };
}

export function checkSource(source: string, filename: string = 'input.ts'): Issue[] {
  const parsed = parseSync(filename, source);
  const errors = parsed.errors;
  const issues: Issue[] = [];
  const report = (start: number, message: string): void => {
    issues.push({ line: source.slice(0, start).split('\n').length, message });
  };

  for (const error of errors) {
    report(error.labels[0]?.start ?? 0, `TypeScript syntax: ${error.message}`);
  }

  if (errors.length === 0) {
    checkPublicDeclarations(parsed.program, docChecker(source, parsed.comments, report));
  }

  return issues;
}

function printIssues(filenames: readonly string[]): number {
  let count = 0;
  for (const filename of filenames) {
    const issues = checkSource(readFileSync(filename, 'utf8'), filename);
    for (const issue of issues) {
      console.error(`${filename}:${issue.line}: ${issue.message}`);
    }

    count += issues.length;
  }

  return count;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filenames = process.argv.slice(2);
  if (filenames.length === 0) {
    filenames.push(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
  }

  if (printIssues(filenames) > 0) {
    process.exitCode = 1;
  } else {
    console.log('Public API TSDoc checks passed.');
  }
}
