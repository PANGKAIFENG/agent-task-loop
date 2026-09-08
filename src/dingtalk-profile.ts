export function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function isValidDingTalkProfile(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value === value.trim()
    && !value.includes(',')
    && !hasControlCharacters(value);
}

export function optionalDingTalkProfile(value: unknown): string | null {
  return value === undefined || value === ''
    ? null
    : isValidDingTalkProfile(value) ? value : null;
}

/**
 * Returns the user id embedded in a production `corpId:userId` profile.
 * Legacy named profiles intentionally return null so callers can retain their
 * existing self-resolution fallback.
 */
export function embeddedDingTalkUserId(value: unknown): string | null {
  if (!isValidDingTalkProfile(value)) return null;
  const parts = value.split(':');
  if (
    parts.length !== 2
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(parts[0] ?? '')
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(parts[1] ?? '')
  ) return null;
  return parts[1] ?? null;
}

export function isValidDingTalkRobotCode(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/u.test(value);
}

export function optionalDingTalkRobotCode(value: unknown): string | null {
  return value === undefined || value === ''
    ? null
    : isValidDingTalkRobotCode(value) ? value : null;
}
