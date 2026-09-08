import { execFile } from 'node:child_process';
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
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  optionalDingTalkProfile,
  optionalDingTalkRobotCode,
} from '../dingtalk-profile.js';

export const LAUNCH_AGENT_LABEL = 'ai.agent-task-loop.runner';
export const LAUNCH_AGENT_FILE_NAME = `${LAUNCH_AGENT_LABEL}.plist`;
export const DINGTALK_STREAM_LAUNCH_AGENT_LABEL = 'ai.agent-task-loop.dingtalk-stream';
export const DINGTALK_STREAM_LAUNCH_AGENT_FILE_NAME = `${DINGTALK_STREAM_LAUNCH_AGENT_LABEL}.plist`;
const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const TIME_ZONE = 'Asia/Shanghai';
const RUNNER_INTERVAL_SECONDS = 15 * 60;

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
  processArguments?: readonly string[];
  repositoryRoot?: string;
  runnerEntry?: string;
  systemTimeZone?: () => string | Promise<string>;
}

export interface RenderDingTalkStreamLaunchAgentOptions extends RenderLaunchAgentOptions {
  streamEntry?: string;
  bridgeEntry?: string;
  dwsExecutable?: string;
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

export interface LaunchAgentProcessOptions extends InspectLaunchAgentOptions {
  commandAdapter?: LaunchAgentCommandAdapter;
  uid?: number;
}

export interface LaunchAgentProcessStatus {
  loaded: boolean;
  running: boolean;
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
    ATL_CLAUDE_CONFIG_DIR: string;
    ATL_CLAUDE_MODEL?: string;
    ANTHROPIC_BASE_URL?: string;
    ATL_DINGTALK_PROFILE?: string;
    ATL_DINGTALK_ROBOT_CODE?: string;
    ATL_DWS_EXECUTABLE?: string;
    ATL_ALLOWED_LOCAL_ROOTS: string;
    HOME: string;
    PATH: string;
  }>;
  workingDirectory: string;
  standardOutPath: string;
  standardErrorPath: string;
}

export interface RenderedDingTalkStreamLaunchAgent {
  label: typeof DINGTALK_STREAM_LAUNCH_AGENT_LABEL;
  path: string;
  plist: string;
  programArguments: readonly string[];
  environmentVariables: Readonly<Record<string, string>>;
  workingDirectory: string;
  standardOutPath: string;
  standardErrorPath: string;
}

const defaultCommandAdapter: LaunchAgentCommandAdapter = {
  async execute(command, args) {
    const result = await promisify(execFile)(command, [...args], {
      encoding: 'utf8',
    });
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

function modelName(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
    throw new LaunchAgentError('ATL_CLAUDE_MODEL must be a valid model name');
  }
  return value;
}

function baseUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.hostname === ''
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.search !== ''
      || parsed.hash !== ''
    ) {
      throw new Error('Unsafe URL');
    }
    return value;
  } catch {
    throw new LaunchAgentError(
      'ANTHROPIC_BASE_URL must be a safe http or https URL',
    );
  }
}

function dingtalkProfile(value: string | undefined): string | undefined {
  const profile = optionalDingTalkProfile(value);
  if (value !== undefined && value !== '' && profile === null) {
    throw new LaunchAgentError(
      'ATL_DINGTALK_PROFILE must contain one explicit DingTalk profile',
    );
  }
  return profile ?? undefined;
}

function dingtalkRobotCode(value: string | undefined): string | undefined {
  const robotCode = optionalDingTalkRobotCode(value);
  if (value !== undefined && value !== '' && robotCode === null) {
    throw new LaunchAgentError(
      'ATL_DINGTALK_ROBOT_CODE must contain one explicit DingTalk robot code',
    );
  }
  return robotCode ?? undefined;
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
    '  <key>StartInterval</key>',
    `  <integer>${RUNNER_INTERVAL_SECONDS}</integer>`,
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
  const nodeExecutable = await existingFile(
    options.nodeExecutable ?? process.execPath,
    'Node executable',
    true,
  );
  const invokedEntry = options.processArguments?.[1] ?? process.argv[1];
  const configuredRunnerEntry = options.runnerEntry ?? (
    invokedEntry !== undefined && basename(invokedEntry) === 'atl-runner.mjs'
      ? invokedEntry
      : undefined
  );
  const runnerEntry = configuredRunnerEntry === undefined
    ? null
    : await existingFile(configuredRunnerEntry, 'packaged runner', false);
  const repositoryRoot = runnerEntry === null
    ? await existingDirectory(
      options.repositoryRoot ?? await resolveRepositoryRoot(),
      'repository root',
    )
    : dirname(runnerEntry);
  const cliPath = runnerEntry ?? await existingFile(
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
  const claudeConfigDirectory = await existingDirectory(
    environment.ATL_CLAUDE_CONFIG_DIR ?? '',
    'ATL_CLAUDE_CONFIG_DIR',
  );
  const stateDirectory = join(
    homeDirectory,
    '.local',
    'state',
    'agent-task-loop',
  );
  const model = modelName(environment.ATL_CLAUDE_MODEL);
  const anthropicBaseUrl = baseUrl(environment.ANTHROPIC_BASE_URL);
  const notificationProfile = dingtalkProfile(environment.ATL_DINGTALK_PROFILE);
  const notificationRobotCode = dingtalkRobotCode(
    environment.ATL_DINGTALK_ROBOT_CODE,
  );
  const dwsExecutable = notificationProfile !== undefined
    && notificationRobotCode !== undefined
    ? await existingFile(
        environment.ATL_DWS_EXECUTABLE,
        'ATL_DWS_EXECUTABLE',
        true,
      )
    : undefined;
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
      ATL_CLAUDE_CONFIG_DIR: claudeConfigDirectory,
      ...(model === undefined ? {} : { ATL_CLAUDE_MODEL: model }),
      ...(anthropicBaseUrl === undefined
        ? {}
        : { ANTHROPIC_BASE_URL: anthropicBaseUrl }),
      ...(notificationProfile === undefined
        ? {}
        : { ATL_DINGTALK_PROFILE: notificationProfile }),
      ...(notificationRobotCode === undefined
        ? {}
        : { ATL_DINGTALK_ROBOT_CODE: notificationRobotCode }),
      ...(dwsExecutable === undefined
        ? {}
        : { ATL_DWS_EXECUTABLE: dwsExecutable }),
      ATL_ALLOWED_LOCAL_ROOTS: await allowedLocalRoots(
        environment.ATL_ALLOWED_LOCAL_ROOTS,
      ),
      HOME: homeDirectory,
      PATH: [dirname(nodeExecutable), MINIMAL_PATH].join(delimiter),
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

function requiredLaunchIdentifier(
  value: string | undefined,
  name: string,
): string {
  if (
    value === undefined
    || !/^[A-Za-z0-9_:+./=-]{1,256}$/u.test(value)
  ) throw new LaunchAgentError(`${name} must contain one explicit identifier`);
  return value;
}

function requiredUnifiedAppId(value: string | undefined): string {
  if (
    value === undefined
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) throw new LaunchAgentError('ATL_DINGTALK_UNIFIED_APP_ID must be a UUID');
  return value;
}

function renderDingTalkStreamPlist(
  input: Omit<RenderedDingTalkStreamLaunchAgent, 'path' | 'plist'>,
): string {
  return [
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
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>ThrottleInterval</key>',
    '  <integer>15</integer>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export async function renderDingTalkStreamLaunchAgent(
  options: RenderDingTalkStreamLaunchAgentOptions = {},
): Promise<RenderedDingTalkStreamLaunchAgent> {
  const environment = options.environment ?? process.env;
  const runner = await renderLaunchAgent(options);
  const runnerEntry = runner.programArguments[1];
  if (runnerEntry === undefined) {
    throw new LaunchAgentError('packaged runner could not be resolved');
  }
  const pluginDirectory = basename(runnerEntry) === 'atl-runner.mjs'
    ? dirname(runnerEntry)
    : join(dirname(dirname(runnerEntry)), 'obsidian-plugin');
  const streamEntry = await existingFile(
    options.streamEntry ?? join(pluginDirectory, 'atl-dingtalk-stream.mjs'),
    'packaged DingTalk Stream listener',
    false,
  );
  const bridgeEntry = await existingFile(
    options.bridgeEntry ?? join(pluginDirectory, 'atl-dingtalk-bridge.mjs'),
    'packaged DingTalk bridge',
    false,
  );
  const dwsExecutable = await existingFile(
    options.dwsExecutable ?? environment.ATL_DWS_EXECUTABLE,
    'DWS executable',
    true,
  );
  const profile = runner.environmentVariables.ATL_DINGTALK_PROFILE;
  const robotCode = runner.environmentVariables.ATL_DINGTALK_ROBOT_CODE;
  const profileParts = profile?.split(':') ?? [];
  if (
    profileParts.length !== 2
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(profileParts[0] ?? '')
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(profileParts[1] ?? '')
  ) throw new LaunchAgentError('ATL_DINGTALK_PROFILE must be corpId:userId');
  if (robotCode === undefined) {
    throw new LaunchAgentError('ATL_DINGTALK_ROBOT_CODE is required');
  }
  const trustedSenderUserId = profileParts[1] as string;
  const homeDirectory = runner.environmentVariables.HOME;
  const stateDirectory = join(homeDirectory, '.local', 'state', 'agent-task-loop');
  const result = {
    label: DINGTALK_STREAM_LAUNCH_AGENT_LABEL,
    programArguments: [runner.programArguments[0] as string, streamEntry],
    environmentVariables: {
      ...runner.environmentVariables,
      ATL_DINGTALK_UNIFIED_APP_ID: requiredUnifiedAppId(
        environment.ATL_DINGTALK_UNIFIED_APP_ID,
      ),
      ATL_DINGTALK_TRUSTED_CONVERSATION_ID: requiredLaunchIdentifier(
        environment.ATL_DINGTALK_TRUSTED_CONVERSATION_ID,
        'ATL_DINGTALK_TRUSTED_CONVERSATION_ID',
      ),
      ATL_DINGTALK_TRUSTED_SENDER_USER_ID: trustedSenderUserId,
      ATL_DINGTALK_BRIDGE_ENTRY: bridgeEntry,
      ATL_DWS_EXECUTABLE: dwsExecutable,
      ATL_NODE_EXECUTABLE: runner.programArguments[0] as string,
      ATL_RUNNER_ENTRY: runnerEntry,
    },
    workingDirectory: runner.workingDirectory,
    standardOutPath: join(stateDirectory, 'dingtalk-stream.stdout.log'),
    standardErrorPath: join(stateDirectory, 'dingtalk-stream.stderr.log'),
  } satisfies Omit<RenderedDingTalkStreamLaunchAgent, 'path' | 'plist'>;
  return {
    ...result,
    path: join(
      homeDirectory,
      'Library',
      'LaunchAgents',
      DINGTALK_STREAM_LAUNCH_AGENT_FILE_NAME,
    ),
    plist: renderDingTalkStreamPlist(result),
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

function missingLaunchAgentService(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = [
    error.message,
    'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '',
  ].join('\n');
  return /could not find service|service not found|no such process|boot-out failed:\s*5:\s*input\/output error/iu.test(details);
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

export async function inspectLaunchAgentProcess(
  options: LaunchAgentProcessOptions = {},
): Promise<LaunchAgentProcessStatus> {
  const commands = options.commandAdapter ?? defaultCommandAdapter;
  try {
    const result = await commands.execute('/bin/launchctl', [
      'print',
      `${targetDomain(options.uid)}/${LAUNCH_AGENT_LABEL}`,
    ]);
    return {
      loaded: true,
      running: /^\s*state\s*=\s*running\s*$/imu.test(result.stdout),
    };
  } catch (error) {
    if (missingLaunchAgentService(error)) {
      return { loaded: false, running: false };
    }
    throw error;
  }
}

export async function kickstartLaunchAgent(
  options: LaunchAgentProcessOptions = {},
): Promise<LaunchAgentProcessStatus> {
  const commands = options.commandAdapter ?? defaultCommandAdapter;
  await commands.execute('/bin/launchctl', [
    'kickstart',
    `${targetDomain(options.uid)}/${LAUNCH_AGENT_LABEL}`,
  ]);
  return { loaded: true, running: true };
}

async function restoreAfterFailedInstall(
  rendered: Pick<RenderedLaunchAgent, 'path' | 'plist'>,
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
  let previousServiceWasLoaded = false;
  try {
    await commands.execute('/usr/bin/plutil', ['-lint', rendered.path]);
    if (previous !== null) {
      try {
        await commands.execute('/bin/launchctl', [
          'bootout',
          domain,
          rendered.path,
        ]);
        previousServiceWasLoaded = true;
      } catch (error) {
        if (!missingLaunchAgentService(error)) {
          throw error;
        }
      }
    }
    await commands.execute('/bin/launchctl', [
      'bootstrap',
      domain,
      rendered.path,
    ]);
  } catch (error) {
    await restoreAfterFailedInstall(rendered, previous);
    if (previous !== null && previousServiceWasLoaded) {
      try {
        await commands.execute('/bin/launchctl', [
          'bootstrap',
          domain,
          rendered.path,
        ]);
      } catch (rollbackError) {
        const installMessage = error instanceof Error
          ? error.message
          : 'LaunchAgent update failed';
        const rollbackMessage = rollbackError instanceof Error
          ? rollbackError.message
          : 'previous service reload failed';
        throw new LaunchAgentError(
          `${installMessage}; rollback failed: ${rollbackMessage}`,
        );
      }
    }
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

async function inspectDingTalkStreamInternal(
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
    DINGTALK_STREAM_LAUNCH_AGENT_FILE_NAME,
  );
  const content = await readExactFile(path);
  if (content === null) {
    return { path, installed: false, managed: false, label: null, content };
  }
  const label = parseTopLevelLabel(content);
  return {
    path,
    installed: true,
    managed: label === DINGTALK_STREAM_LAUNCH_AGENT_LABEL,
    label,
    content,
  };
}

export async function inspectDingTalkStreamLaunchAgent(
  options: InspectLaunchAgentOptions = {},
): Promise<LaunchAgentStatus> {
  const inspected = await inspectDingTalkStreamInternal(options);
  return {
    path: inspected.path,
    installed: inspected.installed,
    managed: inspected.managed,
    label: inspected.label,
  };
}

export async function inspectDingTalkStreamLaunchAgentProcess(
  options: LaunchAgentProcessOptions = {},
): Promise<LaunchAgentProcessStatus> {
  const commands = options.commandAdapter ?? defaultCommandAdapter;
  try {
    const result = await commands.execute('/bin/launchctl', [
      'print',
      `${targetDomain(options.uid)}/${DINGTALK_STREAM_LAUNCH_AGENT_LABEL}`,
    ]);
    return {
      loaded: true,
      running: /^\s*state\s*=\s*running\s*$/imu.test(result.stdout),
    };
  } catch (error) {
    if (missingLaunchAgentService(error)) return { loaded: false, running: false };
    throw error;
  }
}

export async function installDingTalkStreamLaunchAgent(
  options: RenderDingTalkStreamLaunchAgentOptions & {
    commandAdapter?: LaunchAgentCommandAdapter;
    uid?: number;
  } = {},
): Promise<LaunchAgentStatus> {
  const rendered = await renderDingTalkStreamLaunchAgent(options);
  const domain = targetDomain(options.uid);
  const previous = await readExactFile(rendered.path);
  if (
    previous !== null
    && parseTopLevelLabel(previous) !== DINGTALK_STREAM_LAUNCH_AGENT_LABEL
  ) {
    throw new LaunchAgentError(
      'Refusing to overwrite a LaunchAgent with a different Label',
    );
  }
  await mkdir(dirname(rendered.path), { recursive: true, mode: 0o700 });
  await mkdir(dirname(rendered.standardOutPath), { recursive: true, mode: 0o700 });
  await atomicWrite(rendered.path, rendered.plist, previous === null);
  const commands = options.commandAdapter ?? defaultCommandAdapter;
  let previousServiceWasLoaded = false;
  try {
    await commands.execute('/usr/bin/plutil', ['-lint', rendered.path]);
    if (previous !== null) {
      try {
        await commands.execute('/bin/launchctl', ['bootout', domain, rendered.path]);
        previousServiceWasLoaded = true;
      } catch (error) {
        if (!missingLaunchAgentService(error)) throw error;
      }
    }
    await commands.execute('/bin/launchctl', ['bootstrap', domain, rendered.path]);
  } catch (error) {
    await restoreAfterFailedInstall(rendered, previous);
    if (previous !== null && previousServiceWasLoaded) {
      try {
        await commands.execute('/bin/launchctl', ['bootstrap', domain, rendered.path]);
      } catch (rollbackError) {
        const installMessage = error instanceof Error
          ? error.message
          : 'DingTalk Stream LaunchAgent update failed';
        const rollbackMessage = rollbackError instanceof Error
          ? rollbackError.message
          : 'previous service reload failed';
        throw new LaunchAgentError(
          `${installMessage}; rollback failed: ${rollbackMessage}`,
        );
      }
    }
    throw error;
  }
  return {
    path: rendered.path,
    installed: true,
    managed: true,
    label: DINGTALK_STREAM_LAUNCH_AGENT_LABEL,
  };
}

export async function uninstallDingTalkStreamLaunchAgent(
  options: UninstallLaunchAgentOptions = {},
): Promise<LaunchAgentStatus> {
  const inspected = await inspectDingTalkStreamInternal(options);
  if (!inspected.installed) {
    return { path: inspected.path, installed: false, managed: false, label: null };
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
    label: DINGTALK_STREAM_LAUNCH_AGENT_LABEL,
  };
}
