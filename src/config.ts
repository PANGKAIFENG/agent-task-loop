import {
  optionalDingTalkProfile,
  optionalDingTalkRobotCode,
} from './dingtalk-profile.js';
import { MULTICA_CLI_DEFAULT_SQUAD_ID } from './connectors/multica-cli-connector.js';
import { assertVaultWriteAllowed, vaultRoot } from './storage/task-paths.js';

export interface AtlConfig {
  vaultRoot: string;
  dingtalkProfile: string | null;
  dingtalkRobotCode: string | null;
  leaseMinutes: 60;
  boardHost: '127.0.0.1';
  multicaDispatch: MulticaDispatchConfig;
}

// PAW-GOAL-003 T1 (TECH §4): the Multica CLI connector always invokes an
// absolute binary with an explicit profile and workspace. Values come from
// the environment with the accepted Goal scope as defaults.
export interface MulticaDispatchConfig {
  binaryPath: string;
  profile: string;
  workspaceId: string;
  projectId: string;
  squadId: string;
  callTimeoutMs: number;
}

const MULTICA_DEFAULT_BINARY = '/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica';
const MULTICA_DEFAULT_PROFILE = 'desktop-api.multica.ai';
const MULTICA_DEFAULT_WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const MULTICA_DEFAULT_PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const MULTICA_DEFAULT_CALL_TIMEOUT_MS = 20_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requiredMulticaValue(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
): string {
  const value = environment[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

// PAW-GOAL-003-V0.5 D2: exported so the Obsidian plugin can construct the
// same dispatch configuration the CLI uses (same env keys, same defaults,
// same validation) without importing the whole CLI module.
export function multicaDispatchConfig(
  environment: NodeJS.ProcessEnv,
): MulticaDispatchConfig {
  const config: MulticaDispatchConfig = {
    binaryPath: requiredMulticaValue(environment, 'ATL_MULTICA_BINARY', MULTICA_DEFAULT_BINARY),
    profile: requiredMulticaValue(environment, 'ATL_MULTICA_PROFILE', MULTICA_DEFAULT_PROFILE),
    workspaceId: requiredMulticaValue(environment, 'ATL_MULTICA_WORKSPACE_ID', MULTICA_DEFAULT_WORKSPACE_ID),
    projectId: requiredMulticaValue(environment, 'ATL_MULTICA_PROJECT_ID', MULTICA_DEFAULT_PROJECT_ID),
    squadId: requiredMulticaValue(environment, 'ATL_MULTICA_SQUAD_ID', MULTICA_CLI_DEFAULT_SQUAD_ID),
    callTimeoutMs: MULTICA_DEFAULT_CALL_TIMEOUT_MS,
  };
  if (!config.binaryPath.startsWith('/')) {
    throw new InvalidConfigError('ATL_MULTICA_BINARY must be an absolute path');
  }
  if (!UUID_PATTERN.test(config.workspaceId)) {
    throw new InvalidConfigError('ATL_MULTICA_WORKSPACE_ID must be a workspace UUID');
  }
  if (!UUID_PATTERN.test(config.projectId)) {
    throw new InvalidConfigError('ATL_MULTICA_PROJECT_ID must be a project UUID');
  }
  if (!UUID_PATTERN.test(config.squadId)) {
    throw new InvalidConfigError('ATL_MULTICA_SQUAD_ID must be a squad UUID');
  }
  return config;
}

export class InvalidConfigError extends Error {
  readonly code = 'invalid_config';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AtlConfig {
  let root: string;
  try {
    root = vaultRoot(environment.ATL_VAULT_ROOT);
  } catch {
    throw new InvalidConfigError('ATL_VAULT_ROOT is required');
  }
  const dingtalkProfile = optionalDingTalkProfile(
    environment.ATL_DINGTALK_PROFILE,
  );
  if (
    environment.ATL_DINGTALK_PROFILE !== undefined
    && environment.ATL_DINGTALK_PROFILE !== ''
    && dingtalkProfile === null
  ) {
    throw new InvalidConfigError(
      'ATL_DINGTALK_PROFILE must contain one explicit DingTalk profile',
    );
  }
  const dingtalkRobotCode = optionalDingTalkRobotCode(
    environment.ATL_DINGTALK_ROBOT_CODE,
  );
  if (
    environment.ATL_DINGTALK_ROBOT_CODE !== undefined
    && environment.ATL_DINGTALK_ROBOT_CODE !== ''
    && dingtalkRobotCode === null
  ) {
    throw new InvalidConfigError(
      'ATL_DINGTALK_ROBOT_CODE must contain one explicit DingTalk robot code',
    );
  }
  return {
    vaultRoot: root,
    dingtalkProfile,
    dingtalkRobotCode,
    leaseMinutes: 60,
    boardHost: '127.0.0.1',
    multicaDispatch: multicaDispatchConfig(environment),
  };
}

export function assertWriteEnabled(config: AtlConfig): void {
  try {
    assertVaultWriteAllowed(config.vaultRoot);
  } catch {
    throw new InvalidConfigError(
      'Writes outside the OS temporary directory require ATL_ALLOW_REAL_WRITES=1',
    );
  }
}
