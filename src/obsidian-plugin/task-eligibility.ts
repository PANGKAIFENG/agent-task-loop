const ATL_INBOX_PREFIX = '10_Tasks/Inbox/';
const TASK_FILENAME = /^task-[^/]+\.md$/u;

export function isAtlInboxTaskPath(path: string): boolean {
  if (
    !path.startsWith(ATL_INBOX_PREFIX)
    || path.includes('\\')
    || path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return false;
  }
  const segments = path.slice(ATL_INBOX_PREFIX.length).split('/');
  const filename = segments.at(-1) ?? '';
  return segments.length >= 2
    && segments.slice(0, -1).every((segment) => segment !== '')
    && TASK_FILENAME.test(filename);
}

export function taskIdFromPath(path: string): string | null {
  if (!isAtlInboxTaskPath(path)) {
    return null;
  }
  const filename = path.split('/').at(-1);
  return filename === undefined ? null : filename.slice(0, -'.md'.length);
}
