const CREDENTIAL_KEY_PATTERN = /^(?:[A-Za-z0-9]+[_-])*(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|app[_ -]?secret|client[_ -]?secret|private[_ -]?key|password|passwd|credential|token|secret)$/iu;

const INLINE_CREDENTIAL_PATTERN = /(?:(?:["'])?\b(?:[A-Za-z0-9]+[_-])*(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|app[_ -]?secret|client[_ -]?secret|private[_ -]?key|password|passwd|credential|token|secret)\b(?:["'])?)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/giu;

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

function redactStructuredCredentials(value: string): string {
  const lines = value.split('\n');
  const redacted: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /^(\s*)(?:(["'])([^"']+)\2|([A-Za-z0-9_. -]+))(\s*[:=]\s*)(.*?)(\r?)$/u.exec(line);
    const key = match?.[3] ?? match?.[4];
    if (match === null || key === undefined || !CREDENTIAL_KEY_PATTERN.test(key.trim())) {
      redacted.push(line);
      continue;
    }

    const [
      , indentation = '', quote = '', quotedKey, plainKey,
      separator = '', rawValue = '', carriageReturn = '',
    ] = match;
    const renderedKey = quotedKey === undefined ? (plainKey ?? '') : `${quote}${quotedKey}${quote}`;
    redacted.push(`${indentation}${renderedKey}${separator}[REDACTED]${carriageReturn}`);

    if (!separator.includes(':') || !/^[|>][+-]?(?:\s+#.*)?\r?$/u.test(rawValue)) continue;

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

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, '[REDACTED]'),
    redactStructuredCredentials(value),
  );
}
