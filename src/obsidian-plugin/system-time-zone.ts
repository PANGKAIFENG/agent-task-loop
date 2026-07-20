export function resolveSystemTimeZone(
  read: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const timeZone = read().trim();
  return timeZone === '' ? 'UTC' : timeZone;
}
