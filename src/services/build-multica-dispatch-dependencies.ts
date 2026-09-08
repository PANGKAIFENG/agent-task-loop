import { join } from 'node:path';

import {
  MulticaCliConnector,
  type MulticaCliConnectorOptions,
  type MulticaResearchContinuationConnector,
  type MulticaResearchConnector,
} from '../connectors/multica-cli-connector.js';
import type { AtlConfig } from '../config.js';
import type { DispatchDevelopmentTaskDependencies } from './dispatch-development-task.js';
import type { DispatchResearchTaskDependencies } from './dispatch-research-task.js';
import { discoverResearchContext } from './discover-research-context.js';

export const RESEARCH_AGENT_ID = '2e7fa123-cd0b-4469-b6a8-584aedc128dc';
export const RESEARCH_AGENT_MODEL = 'gpt-5.6-sol';
export const RESEARCH_AGENT_MAX_CONCURRENT_TASKS = 10;

interface ResearchMulticaCompositionOptions {
  connectorFactory?: (options: MulticaCliConnectorOptions) => MulticaResearchConnector;
}

export type ResearchMulticaDispatchDependencies = DispatchResearchTaskDependencies & {
  connector: MulticaResearchConnector;
};

function researchConnectorOptions(config: AtlConfig): MulticaCliConnectorOptions {
  return {
    binaryPath: config.multicaDispatch.binaryPath,
    profile: config.multicaDispatch.profile,
    workspaceId: config.multicaDispatch.workspaceId,
    projectId: config.multicaDispatch.projectId,
    assignment: {
      type: 'agent',
      id: RESEARCH_AGENT_ID,
      requiredModel: RESEARCH_AGENT_MODEL,
      requiredMaxConcurrentTasks: RESEARCH_AGENT_MAX_CONCURRENT_TASKS,
    },
    callTimeoutMs: config.multicaDispatch.callTimeoutMs,
  };
}

export function buildResearchMulticaContinuationConnector(
  config: AtlConfig,
  connectorFactory: (
    options: MulticaCliConnectorOptions,
  ) => MulticaResearchContinuationConnector = (options) => new MulticaCliConnector(options),
): MulticaResearchContinuationConnector {
  return connectorFactory(researchConnectorOptions(config));
}

// PAW-GOAL-003-V0.5 D2: one construction path for the Multica dispatch
// dependencies shared by the CLI and the Obsidian plugin — the plugin must
// not re-derive connector options (or drift from the CLI target), it builds
// the exact same connector + target + allowed-context-roots surface.
export function buildMulticaDispatchDependencies(
  config: AtlConfig,
  allowedContextRoots: readonly string[],
): DispatchDevelopmentTaskDependencies {
  const connector = new MulticaCliConnector({
    binaryPath: config.multicaDispatch.binaryPath,
    profile: config.multicaDispatch.profile,
    workspaceId: config.multicaDispatch.workspaceId,
    projectId: config.multicaDispatch.projectId,
    squadId: config.multicaDispatch.squadId,
    callTimeoutMs: config.multicaDispatch.callTimeoutMs,
  });
  return {
    connector,
    target: {
      workspaceId: config.multicaDispatch.workspaceId,
      projectId: config.multicaDispatch.projectId,
    },
    allowedContextRoots: [...allowedContextRoots],
  };
}

export function buildResearchMulticaDispatchDependencies(
  config: AtlConfig,
  additionalAllowedContextRoots: readonly string[],
  options: ResearchMulticaCompositionOptions = {},
): ResearchMulticaDispatchDependencies {
  const allowedContextRoots = [
    config.vaultRoot,
    ...additionalAllowedContextRoots.filter((root) => root !== config.vaultRoot),
  ];
  const connectorFactory = options.connectorFactory
    ?? ((connectorOptions: MulticaCliConnectorOptions) => (
      new MulticaCliConnector(connectorOptions)
    ));
  const connector = connectorFactory(researchConnectorOptions(config));
  return {
    connector,
    target: {
      workspaceId: config.multicaDispatch.workspaceId,
      projectId: config.multicaDispatch.projectId,
    },
    runtimeRoot: join(config.vaultRoot, '.atl-runtime'),
    allowedContextRoots,
    contextBaseRoot: config.vaultRoot,
    discoverContext: (input) => discoverResearchContext(input, {
      vaultRoot: config.vaultRoot,
      allowedLocalRoots: allowedContextRoots,
    }),
  };
}
