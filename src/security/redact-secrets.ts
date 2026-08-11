import YAML, { isMap, isNode, isScalar, isSeq } from 'yaml';

const CREDENTIAL_KEY_SUFFIX_PATTERN = /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|APP_SECRET|CLIENT_SECRET|PRIVATE_KEY|PASSWORD|PASSWD|CREDENTIAL|TOKEN|SECRET)$/u;

const INLINE_CREDENTIAL_PATTERN = /(?:(?:["'])?\b[A-Za-z0-9_-]*(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|app[_ -]?secret|client[_ -]?secret|private[_ -]?key|password|passwd|credential|token|secret)\b(?:["'])?)\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:''|\\.|[^'\\\r\n])*'|[^\s,;}]+)/giu;

const YAML_NODE_PROPERTIES_PATTERN = /^(?:(?:![^\s]+|&[^\s]+)\s+)*/u;
const YAML_BLOCK_SCALAR_PATTERN = /^(?:(?:![^\s]+|&[^\s]+)\s+)*[|>](?:[+-]?[1-9]?|[1-9][+-]?)(?:\s+#.*)?\r?$/u;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /AKIA[0-9A-Z]{16}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /npm_[A-Za-z0-9]{20,}/g,
  /whsec_[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  INLINE_CREDENTIAL_PATTERN,
];

function indentationWidth(value: string): number {
  return /^\s*/u.exec(value)?.[0].replace(/\r$/u, '').length ?? 0;
}

function isCredentialKey(value: string): boolean {
  const normalized = value.trim()
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toUpperCase();
  return CREDENTIAL_KEY_SUFFIX_PATTERN.test(normalized);
}

function hasQuotedScalarTerminator(
  value: string,
  quote: '"' | "'",
  includesOpeningQuote: boolean,
): boolean {
  let index = includesOpeningQuote ? 1 : 0;
  while (index < value.length) {
    const character = value[index];
    if (quote === '"' && character === '\\') {
      index += 2;
      continue;
    }
    if (character !== quote) {
      index += 1;
      continue;
    }
    if (quote === "'" && value[index + 1] === "'") {
      index += 2;
      continue;
    }
    return true;
  }
  return false;
}

function collectYamlCredentialRanges(
  node: unknown,
  ranges: Array<{ start: number; end: number }>,
): void {
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value ?? '') : '';
      const range = isNode(pair.value) ? pair.value.range : undefined;
      if (
        isCredentialKey(key)
        && range !== undefined
        && range !== null
        && Number.isInteger(range[0])
        && Number.isInteger(range[1])
        && range[1] > range[0]
      ) {
        ranges.push({ start: range[0], end: range[1] });
        continue;
      }
      collectYamlCredentialRanges(pair.value, ranges);
    }
    return;
  }

  if (isSeq(node)) {
    for (const item of node.items) collectYamlCredentialRanges(item, ranges);
  }
}

function redactYamlCredentials(value: string, acceptPartialDocuments = false): string {
  let documents: ReturnType<typeof YAML.parseAllDocuments>;
  try {
    documents = YAML.parseAllDocuments(value, { keepSourceTokens: true });
  } catch {
    return value;
  }
  if (!acceptPartialDocuments && documents.some((document) => document.errors.length > 0)) {
    return value;
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (const document of documents) collectYamlCredentialRanges(document.contents, ranges);

  return ranges
    .sort((left, right) => right.start - left.start)
    .reduce((redacted, range) => {
      const matched = redacted.slice(range.start, range.end);
      const trailingLineBreak = /(?:\r?\n)$/u.exec(matched)?.[0] ?? '';
      return `${redacted.slice(0, range.start)}[REDACTED]${trailingLineBreak}${redacted.slice(range.end)}`;
    }, value);
}

function splitLinesPreservingEndings(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

type MarkdownContainer =
  | { kind: 'blockquote' }
  | { kind: 'list'; contentIndent: number };

type MarkdownYamlFence = {
  containers: MarkdownContainer[];
  fence: string;
  bodyIndent: number;
};

function parseMarkdownYamlFence(line: string): MarkdownYamlFence | null {
  let offset = 0;
  let column = 0;
  const containers: MarkdownContainer[] = [];
  while (true) {
    const remainder = line.slice(offset);
    const blockquoteMatch = /^( {0,3})>[ \t]?/u.exec(remainder);
    if (blockquoteMatch !== null) {
      const container = blockquoteMatch[0];
      column = advanceMarkdownColumn(column, container);
      offset += container.length;
      containers.push({ kind: 'blockquote' });
      continue;
    }
    const listMatch = /^( {0,3})(?:[-+*]|\d{1,9}[.)])([ \t]+)/u.exec(
      remainder,
    );
    if (listMatch === null) break;
    const container = listMatch[0];
    const startColumn = column;
    column = advanceMarkdownColumn(column, container);
    offset += container.length;
    containers.push({ kind: 'list', contentIndent: column - startColumn });
  }

  const match = /^( {0,3})(`{3,}|~{3,})[ \t]*ya?ml\b[^\r\n]*\r?\n?$/iu.exec(
    line.slice(offset),
  );
  if (match === null) return null;
  const leading = match[1] ?? '';
  const startColumn = column;
  column = advanceMarkdownColumn(column, leading);
  return {
    containers,
    fence: match[2] ?? '',
    bodyIndent: column - startColumn,
  };
}

function advanceMarkdownColumn(initialColumn: number, value: string): number {
  let column = initialColumn;
  for (const character of value) {
    column = character === '\t' ? column + (4 - (column % 4)) : column + 1;
  }
  return column;
}

function stripIndentToColumn(
  value: string,
  initialColumn: number,
  targetColumn: number,
  requireFull: boolean,
): { remainder: string; column: number } | null {
  let offset = 0;
  let column = initialColumn;
  while (column < targetColumn) {
    const character = value[offset];
    if (character !== ' ' && character !== '\t') break;
    column = advanceMarkdownColumn(column, character);
    offset += 1;
  }
  if (requireFull && column < targetColumn) return null;
  return { remainder: value.slice(offset), column };
}

function stripFenceContainer(
  line: string,
  fence: MarkdownYamlFence,
  requireFull: boolean,
  includeBodyIndent = true,
): string | null {
  let remainder = line;
  let column = 0;
  for (const container of fence.containers) {
    if (container.kind === 'blockquote') {
      const match = /^( {0,3})>[ \t]?/u.exec(remainder);
      if (match === null) return null;
      column = advanceMarkdownColumn(column, match[0]);
      remainder = remainder.slice(match[0].length);
      continue;
    }
    const stripped = stripIndentToColumn(
      remainder,
      column,
      column + container.contentIndent,
      requireFull,
    );
    if (stripped === null) return null;
    ({ remainder, column } = stripped);
  }
  if (!includeBodyIndent) return remainder;
  return stripIndentToColumn(
    remainder,
    column,
    column + fence.bodyIndent,
    requireFull,
  )?.remainder ?? null;
}

function stripFenceBodyContainer(line: string, fence: MarkdownYamlFence): string {
  return stripFenceContainer(line, fence, false) ?? line;
}

function stripFenceClosingContainer(
  line: string,
  fence: MarkdownYamlFence,
): string | null {
  return stripFenceContainer(line, fence, true, false);
}

function buildFenceBodyPrefix(fence: MarkdownYamlFence): string {
  let prefix = '';
  for (const container of fence.containers) {
    if (container.kind === 'blockquote') {
      prefix += '> ';
      continue;
    }
    prefix += ' '.repeat(container.contentIndent);
  }
  return `${prefix}${' '.repeat(fence.bodyIndent)}`;
}

function prefixFenceBody(value: string, fence: MarkdownYamlFence): string {
  const prefix = buildFenceBodyPrefix(fence);
  if (prefix.length === 0) return value;
  return splitLinesPreservingEndings(value)
    .map((line) => `${prefix}${line}`)
    .join('');
}

function redactYamlCredentialsLinewise(value: string): string {
  return splitLinesPreservingEndings(value).map((line) => {
    const ending = /\r?\n$/u.exec(line)?.[0] ?? '';
    const content = ending === '' ? line : line.slice(0, -ending.length);
    return `${redactYamlCredentials(content)}${ending}`;
  }).join('');
}

function redactExplicitYamlCredentials(value: string): string {
  const lines = value.split('\n');
  const redacted: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const keyMatch = /^(\s*)\?\s*(?:(['"])([^'"]+)\2|([A-Za-z0-9_. -]+))\s*(?:#.*)?\r?$/u.exec(line);
    const key = keyMatch?.[3] ?? keyMatch?.[4];
    if (keyMatch === null || key === undefined || !isCredentialKey(key)) {
      redacted.push(line);
      continue;
    }

    redacted.push(line);
    const valueLine = lines[index + 1] ?? '';
    const valueMatch = /^(\s*):\s*(.*?)(\r?)$/u.exec(valueLine);
    if (valueMatch === null) continue;
    const indentation = valueMatch[1] ?? '';
    const rawValue = valueMatch[2] ?? '';
    redacted.push(`${indentation}: [REDACTED]${valueMatch[3] ?? ''}`);
    index += 1;

    const trimmedValue = rawValue.trimStart();
    const nodeProperties = YAML_NODE_PROPERTIES_PATTERN.exec(trimmedValue)?.[0] ?? '';
    const scalarValue = trimmedValue.slice(nodeProperties.length);
    const scalarQuote = scalarValue.startsWith('"')
      ? '"'
      : scalarValue.startsWith("'")
        ? "'"
        : null;
    if (scalarQuote !== null && !hasQuotedScalarTerminator(scalarValue, scalarQuote, true)) {
      while (index + 1 < lines.length) {
        index += 1;
        if (hasQuotedScalarTerminator(lines[index] ?? '', scalarQuote, false)) break;
      }
      continue;
    }
    if (!YAML_BLOCK_SCALAR_PATTERN.test(rawValue)) continue;
    const blockIndentation = indentationWidth(indentation);
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1] ?? '';
      if (nextLine.replace(/\r$/u, '').trim() === '') {
        index += 1;
        continue;
      }
      if (indentationWidth(nextLine) <= blockIndentation) break;
      index += 1;
    }
  }
  return redacted.join('\n');
}

function redactYamlFenceBody(value: string): string {
  return redactStructuredCredentials(
    redactYamlCredentialsLinewise(
      redactExplicitYamlCredentials(redactYamlCredentials(value, true)),
    ),
  );
}

function redactFencedYamlCredentials(value: string): string {
  const lines = splitLinesPreservingEndings(value);
  const redacted: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const openingLine = lines[index] ?? '';
    const opening = parseMarkdownYamlFence(openingLine);
    if (opening === null) {
      redacted.push(openingLine);
      continue;
    }

    let closingIndex = -1;
    for (let candidateIndex = index + 1; candidateIndex < lines.length; candidateIndex += 1) {
      const candidate = stripFenceClosingContainer(lines[candidateIndex] ?? '', opening);
      if (candidate === null) continue;
      const closingFence = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/u.exec(candidate)?.[1];
      if (
        closingFence !== undefined
        && closingFence[0] === opening.fence[0]
        && closingFence.length >= opening.fence.length
      ) {
        closingIndex = candidateIndex;
        break;
      }
    }

    const bodyEnd = closingIndex < 0 ? lines.length : closingIndex;
    const bodyLines = lines.slice(index + 1, bodyEnd);
    const yamlBody = bodyLines
      .map((line) => stripFenceBodyContainer(line, opening))
      .join('');
    const redactedBody = redactYamlFenceBody(yamlBody);
    redacted.push(openingLine);
    redacted.push(redactedBody === yamlBody ? bodyLines.join('') : prefixFenceBody(redactedBody, opening));
    if (closingIndex >= 0) {
      redacted.push(lines[closingIndex] ?? '');
      index = closingIndex;
    } else {
      index = lines.length;
    }
  }

  return redacted.join('');
}

function redactStructuredCredentials(value: string): string {
  const lines = value.split('\n');
  const redacted: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /^(\s*)(?:(-\s+))?(?:(["'])([^"']+)\3|([A-Za-z0-9_. -]+))(\s*[:=]\s*)(.*?)(\r?)$/u.exec(line);
    const key = match?.[4] ?? match?.[5];
    if (match === null || key === undefined || !isCredentialKey(key)) {
      redacted.push(line);
      continue;
    }

    const [
      , indentation = '', listMarker = '', quote = '', quotedKey, plainKey,
      separator = '', rawValue = '', carriageReturn = '',
    ] = match;
    const renderedKey = quotedKey === undefined ? (plainKey ?? '') : `${quote}${quotedKey}${quote}`;
    redacted.push(`${indentation}${listMarker}${renderedKey}${separator}[REDACTED]${carriageReturn}`);

    const trimmedValue = rawValue.trimStart();
    const nodeProperties = YAML_NODE_PROPERTIES_PATTERN.exec(trimmedValue)?.[0] ?? '';
    const scalarValue = trimmedValue.slice(nodeProperties.length);
    const scalarQuote = scalarValue.startsWith('"')
      ? '"'
      : scalarValue.startsWith("'")
        ? "'"
        : null;
    if (
      scalarQuote !== null
      && !hasQuotedScalarTerminator(scalarValue, scalarQuote, true)
    ) {
      while (index + 1 < lines.length) {
        index += 1;
        if (hasQuotedScalarTerminator(lines[index] ?? '', scalarQuote, false)) break;
      }
      continue;
    }

    if (
      !separator.includes(':')
      || !YAML_BLOCK_SCALAR_PATTERN.test(rawValue)
    ) continue;

    const blockIndentation = indentationWidth(indentation) + listMarker.length;
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1] ?? '';
      if (nextLine.replace(/\r$/u, '').trim() === '') {
        index += 1;
        continue;
      }
      if (indentationWidth(nextLine) <= blockIndentation) break;
      index += 1;
    }
  }

  return redacted.join('\n');
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, '[REDACTED]'),
    redactStructuredCredentials(redactFencedYamlCredentials(redactYamlCredentials(value))),
  );
}
