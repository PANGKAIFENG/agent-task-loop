const CREDENTIAL_KEY_SUFFIX_PATTERN = /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|APP_SECRET|CLIENT_SECRET|PRIVATE_KEY|PASSWORD|PASSWD|CREDENTIAL|TOKEN|SECRET)$/u;

const INLINE_CREDENTIAL_PATTERN = /(?:(?:["'])?\b[A-Za-z0-9_-]*(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|app[_ -]?secret|client[_ -]?secret|private[_ -]?key|password|passwd|credential|token|secret)\b(?:["'])?)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/giu;

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

    if (
      !separator.includes(':')
      || !/^[|>](?:[+-]?[1-9]?|[1-9][+-]?)(?:\s+#.*)?\r?$/u.test(rawValue)
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
    redactStructuredCredentials(value),
  );
}
