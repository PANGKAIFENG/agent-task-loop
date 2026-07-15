import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

export const LAUNCH_AGENT_LABEL = 'ai.agent-task-loop.runner';
export const LAUNCH_AGENT_FILE_NAME = `${LAUNCH_AGENT_LABEL}.plist`;
const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const TIME_ZONE = 'Asia/Shanghai';

export class LaunchAgentError extends Error {
  readonly code = 'invalid_scheduler_configuration';

  constructor(message: string) {
    super(message);
    this.name = 'LaunchAgentError';
  }
}

export interface RenderLaunchAgentOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  nodeExecutable?: string;
  repositoryRoot?: string;
  systemTimeZone?: () => string | Promise<string>;
}

export interface LaunchAgentCommandAdapter {
  execute(
    command: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface LaunchAgentLifecycleOptions extends RenderLaunchAgentOptions {
  commandAdapter?: LaunchAgentCommandAdapter;
  uid?: number;
}

export interface InspectLaunchAgentOptions {
  homeDirectory?: string;
}

export interface UninstallLaunchAgentOptions extends InspectLaunchAgentOptions {
  commandAdapter?: LaunchAgentCommandAdapter;
  uid?: number;
}

export interface LaunchAgentStatus {
  path: string;
  installed: boolean;
  managed: boolean;
  label: string | null;
}

export interface RenderedLaunchAgent {
  label: typeof LAUNCH_AGENT_LABEL;
  path: string;
  plist: string;
  programArguments: readonly string[];
  environmentVariables: Readonly<{
    ATL_VAULT_ROOT: string;
    ATL_ALLOW_REAL_WRITES: '1';
    ATL_AGENT_DRIVER: 'claude';
    ATL_CLAUDE_BIN: string;
    ATL_ALLOWED_LOCAL_ROOTS: string;
    ATL_DAILY_LIMIT: string;
    HOME: string;
    PATH: string;
  }>;
  workingDirectory: string;
  standardOutPath: string;
  standardErrorPath: string;
}

const defaultCommandAdapter: LaunchAgentCommandAdapter = {
  async execute(command, args) {
    const result = await execa(command, [...args]);
    return { stdout: result.stdout, stderr: result.stderr };
  },
};

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function decodeXml(value: string): string | null {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) {
    return null;
  }
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function parseTopLevelLabel(plist: string): string | null {
  const tokens = plist.match(
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<\/?[A-Za-z][^>]*>|[^<]+/g,
  );
  if (tokens === null || !tokens.some((token) => /^<plist\b/.test(token))) {
    return null;
  }

  let dictionaryDepth = 0;
  let arrayDepth = 0;
  let capture: 'key' | 'string' | null = null;
  let capturedText = '';
  let pendingKey: string | null = null;
  const labels: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('<') && !token.startsWith('<!--')) {
      if (/^<dict(?:\s[^>]*)?>$/.test(token)) {
        dictionaryDepth += 1;
        if (dictionaryDepth !== 1 || arrayDepth !== 0) {
          pendingKey = null;
        }
      } else if (token === '</dict>') {
        dictionaryDepth -= 1;
        if (dictionaryDepth < 0) {
          return null;
        }
        pendingKey = null;
      } else if (/^<array(?:\s[^>]*)?>$/.test(token)) {
        arrayDepth += 1;
        pendingKey = null;
      } else if (token === '</array>') {
        arrayDepth -= 1;
        if (arrayDepth < 0) {
          return null;
        }
        pendingKey = null;
      } else if (
        token === '<key>'
        && dictionaryDepth === 1
        && arrayDepth === 0
      ) {
        capture = 'key';
        capturedText = '';
      } else if (token === '</key>' && capture === 'key') {
        pendingKey = decodeXml(capturedText.trim());
        capture = null;
      } else if (
        token === '<string>'
        && dictionaryDepth === 1
        && arrayDepth === 0
      ) {
        capture = 'string';
        capturedText = '';
      } else if (token === '</string>' && capture === 'string') {
        const value = decodeXml(capturedText);
        if (pendingKey === 'Label' && value !== null) {
          labels.push(value);
        }
        pendingKey = null;
        capture = null;
      } else if (
        pendingKey !== null
        && dictionaryDepth === 1
        && arrayDepth === 0
        && /^<(?:true|false|integer|real|data|date)\b/.test(token)
      ) {
        pendingKey = null;
      }
      continue;
    }
    if (capture !== null) {
      capturedText += token;
    }
  }
  if (dictionaryDepth !== 0 || arrayDepth !== 0 || labels.length !== 1) {
    return null;
  }
  return labels[0] ?? null;
}

async function existingDirectory(path: string, name: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new LaunchAgentError(`${name} must be an absolute existing directory`);
  }
  try {
    const canonical = await realpath(path);
    if (!isAbsolute(canonical) || !(await stat(canonical)).isDirectory()) {
      throw new Error('Not a directory');
    }
    return canonical;
  } catch {
    throw new LaunchAgentError(`${name} must be an absolute existing directory`);
  }
}

async function resolveRepositoryRoot(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const packageJson = JSON.parse(
        await readFile(join(directory, 'package.json'), 'utf8'),
      ) as { name?: unknown };
      if (packageJson.name === 'agent-task-loop') {
        return await existingDirectory(directory, 'repository root');
      }
    } catch {
      // Continue toward the filesystem root until this package is found.
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new LaunchAgentError('repository root could not be resolved');
    }
    directory = parent;
  }
}

async function existingFile(
  path: string | undefined,
  name: string,
  executable: boolean,
): Promise<string> {
  if (path === undefined || !isAbsolute(path)) {
    throw new LaunchAgentError(`${name} must be an absolute existing file`);
  }
  try {
    const canonical = await realpath(path);
    if (!isAbsolute(canonical) || !(await stat(canonical)).isFile()) {
      throw new Error('Not a file');
    }
    if (executable) {
      await access(canonical, constants.X_OK);
    }
    return canonical;
  } catch {
    throw new LaunchAgentError(`${name} must be an absolute existing file`);
  }
}

async function allowedLocalRoots(value: string | undefined): Promise<string> {
  if (value === undefined || value.trim() === '') {
    return '';
  }
  const roots = value.split(delimiter).filter((root) => root !== '');
  if (roots.length === 0) {
    throw new LaunchAgentError(
      'ATL_ALLOWED_LOCAL_ROOTS must contain absolute existing directories',
    );
  }
  return (await Promise.all(roots.map((root) => existingDirectory(
    root,
    'ATL_ALLOWED_LOCAL_ROOTS',
  )))).join(delimiter);
}

function positiveInteger(value: string | undefined): string {
  const candidate = value ?? '3';
  if (!/^[1-9]\d*$/.test(candidate)) {
    throw new LaunchAgentError('ATL_DAILY_LIMIT must be a positive integer');
  }
  return candidate;
}

function plistArray(values: readonly string[], indent: string): string[] {
  return [
    `${indent}<array>`,
    ...values.map((value) => `${indent}  <string>${xml(value)}</string>`),
    `${indent}</array>`,
  ];
}

function renderPlist(input: Omit<RenderedLaunchAgent, 'path' | 'plist'>): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(input.label)}</string>`,
    '  <key>ProgramArguments</key>',
    ...plistArray(input.programArguments, '  '),
    '  <key>WorkingDirectory</key>',
    `  <string>${xml(input.workingDirectory)}</string>`,
    '  <key>StandardOutPath</key>',
    `  <string>${xml(input.standardOutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(input.standardErrorPath)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(input.environmentVariables).flatMap(([key, value]) => [
      `    <key>${xml(key)}</key>`,
      `    <string>${xml(value)}</string>`,
    ]),
    '  </dict>',
    '  <key>StartCalendarInterval</key>',
    '  <array>',
    ...Array.from({ length: 15 }, (_, index) => index + 8).flatMap((hour) => [
      '    <dict>',
      '      <key>Hour</key>',
      `      <integer>${hour}</integer>`,
      '      <key>Minute</key>',
      '      <integer>0</integer>',
      '    </dict>',
    ]),
    '  </array>',
    '</dict>',
    '</plist>',
    '',
  ];
  return lines.join('\n');
}

export async function renderLaunchAgent(
  options: RenderLaunchAgentOptions = {},
): Promise<RenderedLaunchAgent> {
  const environment = options.environment ?? process.env;
  const systemTimeZone = await (
    options.systemTimeZone?.()
    ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  if (systemTimeZone !== TIME_ZONE) {
    throw new LaunchAgentError(`System timezone must be ${TIME_ZONE}`);
  }

  const homeDirectory = await existingDirectory(
    options.homeDirectory ?? homedir(),
    'HOME',
  );
  const repositoryRoot = await existingDirectory(
    options.repositoryRoot ?? await resolveRepositoryRoot(),
    'repository root',
  );
  const nodeExecutable = await existingFile(
    options.nodeExecutable ?? process.execPath,
    'Node executable',
    true,
  );
  const cliPath = await existingFile(
    join(repositoryRoot, 'build', 'server', 'cli.js'),
    'built CLI',
    false,
  );
  const vaultRoot = await existingDirectory(
    environment.ATL_VAULT_ROOT ?? '',
    'ATL_VAULT_ROOT',
  );
  const claudeBinary = await existingFile(
    environment.ATL_CLAUDE_BIN,
    'ATL_CLAUDE_BIN',
    true,
  );
  const stateDirectory = join(
    homeDirectory,
    '.local',
    'state',
    'agent-task-loop',
  );
  const result = {
    label: LAUNCH_AGENT_LABEL,
    programArguments: [
      nodeExecutable,
      cliPath,
      'runner',
      'run-once',
      '--driver',
      'claude',
    ],
    environmentVariables: {
      ATL_VAULT_ROOT: vaultRoot,
      ATL_ALLOW_REAL_WRITES: '1',
      ATL_AGENT_DRIVER: 'claude',
      ATL_CLAUDE_BIN: claudeBinary,
      ATL_ALLOWED_LOCAL_ROOTS: await allowedLocalRoots(
        environment.ATL_ALLOWED_LOCAL_ROOTS,
      ),
      ATL_DAILY_LIMIT: positiveInteger(environment.ATL_DAILY_LIMIT),
      HOME: homeDirectory,
      PATH: MINIMAL_PATH,
    },
    workingDirectory: repositoryRoot,
    standardOutPath: join(stateDirectory, 'runner.stdout.log'),
    standardErrorPath: join(stateDirectory, 'runner.stderr.log'),
  } satisfies Omit<RenderedLaunchAgent, 'path' | 'plist'>;
  return {
    ...result,
    path: join(
      homeDirectory,
      'Library',
      'LaunchAgents',
      LAUNCH_AGENT_FILE_NAME,
    ),
    plist: renderPlist(result),
  };
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === code;
}

async function readExactFile(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new LaunchAgentError('LaunchAgent path is not a regular file');
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) {
      return null;
    }
    if (error instanceof LaunchAgentError) {
      throw error;
    }
    throw new LaunchAgentError('LaunchAgent path cannot be read safely');
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(
  path: string,
  content: string,
  createOnly: boolean,
): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle;
  let temporaryExists = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (createOnly) {
      await link(temporaryPath, path);
      await unlink(temporaryPath);
      temporaryExists = false;
    } else {
      await rename(temporaryPath, path);
      temporaryExists = false;
    }
  } finally {
    await handle?.close();
    if (temporaryExists) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function inspectInternal(
  options: InspectLaunchAgentOptions,
): Promise<LaunchAgentStatus & { content: string | null }> {
  const homeDirectory = await existingDirectory(
    options.homeDirectory ?? homedir(),
    'HOME',
  );
  const path = join(
    homeDirectory,
    'Library',
    'LaunchAgents',
    LAUNCH_AGENT_FILE_NAME,
  );
  const content = await readExactFile(path);
  if (content === null) {
    return {
      path,
      installed: false,
      managed: false,
      label: null,
      content,
    };
  }
  const label = parseTopLevelLabel(content);
  return {
    path,
    installed: true,
    managed: label === LAUNCH_AGENT_LABEL,
    label,
    content,
  };
}

export async function inspectLaunchAgent(
  options: InspectLaunchAgentOptions = {},
): Promise<LaunchAgentStatus> {
  const inspected = await inspectInternal(options);
  return {
    path: inspected.path,
    installed: inspected.installed,
    managed: inspected.managed,
    label: inspected.label,
  };
}

function targetDomain(uid: number | undefined): string {
  const resolvedUid = uid ?? process.getuid?.();
  if (
    resolvedUid === undefined
    || !Number.isSafeInteger(resolvedUid)
    || resolvedUid < 0
  ) {
    throw new LaunchAgentError('A valid user ID is required');
  }
  return `gui/${resolvedUid}`;
}

async function restoreAfterFailedInstall(
  rendered: RenderedLaunchAgent,
  previous: string | null,
): Promise<void> {
  const current = await readExactFile(rendered.path);
  if (current !== rendered.plist) {
    return;
  }
  if (previous === null) {
    await unlink(rendered.path);
    return;
  }
  await atomicWrite(rendered.path, previous, false);
}

export async function installLaunchAgent(
  options: LaunchAgentLifecycleOptions = {},
): Promise<LaunchAgentStatus> {
  const rendered = await renderLaunchAgent(options);
  const domain = targetDomain(options.uid);
  const previous = await readExactFile(rendered.path);
  if (
    previous !== null
    && parseTopLevelLabel(previous) !== LAUNCH_AGENT_LABEL
  ) {
    throw new LaunchAgentError(
      'Refusing to overwrite a LaunchAgent with a different Label',
    );
  }

  await mkdir(dirname(rendered.path), { recursive: true, mode: 0o700 });
  await mkdir(dirname(rendered.standardOutPath), {
    recursive: true,
    mode: 0o700,
  });
  await atomicWrite(rendered.path, rendered.plist, previous === null);
  const commands = options.commandAdapter ?? defaultCommandAdapter;
  try {
    await commands.execute('/usr/bin/plutil', ['-lint', rendered.path]);
    await commands.execute('/bin/launchctl', [
      'bootstrap',
      domain,
      rendered.path,
    ]);
  } catch (error) {
    await restoreAfterFailedInstall(rendered, previous);
    throw error;
  }
  return {
    path: rendered.path,
    installed: true,
    managed: true,
    label: LAUNCH_AGENT_LABEL,
  };
}

export async function uninstallLaunchAgent(
  options: UninstallLaunchAgentOptions = {},
): Promise<LaunchAgentStatus> {
  const inspected = await inspectInternal(options);
  if (!inspected.installed) {
    return {
      path: inspected.path,
      installed: false,
      managed: false,
      label: null,
    };
  }
  if (!inspected.managed || inspected.content === null) {
    throw new LaunchAgentError(
      'Refusing to remove a LaunchAgent with a different Label',
    );
  }
  const commands = options.commandAdapter ?? defaultCommandAdapter;
  await commands.execute('/bin/launchctl', [
    'bootout',
    targetDomain(options.uid),
    inspected.path,
  ]);
  if (await readExactFile(inspected.path) !== inspected.content) {
    throw new LaunchAgentError('LaunchAgent changed during uninstall');
  }
  await unlink(inspected.path);
  return {
    path: inspected.path,
    installed: false,
    managed: true,
    label: LAUNCH_AGENT_LABEL,
  };
}
