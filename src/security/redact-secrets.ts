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

function redactYamlCredentials(value: string): string {
  let documents: ReturnType<typeof YAML.parseAllDocuments>;
  try {
    documents = YAML.parseAllDocuments(value, { keepSourceTokens: true });
  } catch {
    return value;
  }
  if (documents.some((document) => document.errors.length > 0)) return value;

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
    redactStructuredCredentials(redactYamlCredentials(value)),
  );
}
