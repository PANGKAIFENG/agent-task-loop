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
