const ATL_INBOX_PREFIX = '10_Tasks/Inbox/';
const ATL_TASK_PREFIX = '10_Tasks/';
const LIFECYCLE_FOLDERS = new Set(['Inbox', 'Active', 'Archive']);
const TASK_FILENAME = /^task-[^/]+\.md$/u;

function hasSafeSegments(path: string): boolean {
  return !path.includes('\\')
    && !path.split('/').some((segment) => (
      segment === '' || segment === '.' || segment === '..'
    ));
}

export function isAtlTaskPath(path: string): boolean {
  if (!path.startsWith(ATL_TASK_PREFIX) || !hasSafeSegments(path)) {
    return false;
  }
  const segments = path.slice(ATL_TASK_PREFIX.length).split('/');
  const [lifecycle] = segments;
  const filename = segments.at(-1) ?? '';
  return lifecycle !== undefined
    && LIFECYCLE_FOLDERS.has(lifecycle)
    && segments.length >= 3
    && TASK_FILENAME.test(filename);
}

export function isAtlInboxTaskPath(path: string): boolean {
  if (
    !path.startsWith(ATL_INBOX_PREFIX)
    || !hasSafeSegments(path)
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
  if (!isAtlTaskPath(path)) {
    return null;
  }
  const filename = path.split('/').at(-1);
  return filename === undefined ? null : filename.slice(0, -'.md'.length);
}
