import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config.js';
import type { MulticaCliConnectorOptions } from '../../../src/connectors/multica-cli-connector.js';
import {
  buildMulticaDispatchDependencies,
  buildResearchMulticaDispatchDependencies,
  RESEARCH_AGENT_ID,
  RESEARCH_AGENT_MAX_CONCURRENT_TASKS,
  RESEARCH_AGENT_MODEL,
} from '../../../src/services/build-multica-dispatch-dependencies.js';

describe('buildMulticaDispatchDependencies (PAW-GOAL-003-V0.5 D2)', () => {
  it('derives the connector and target from the shared dispatch config', () => {
    const config = loadConfig({
      ATL_VAULT_ROOT: '/tmp/vault',
      ATL_MULTICA_WORKSPACE_ID: '89440e05-518e-4c7e-aa80-0afa2be21196',
      ATL_MULTICA_PROJECT_ID: 'b70aeddc-4a32-47ed-a288-571f5475634a',
    });
    const dependencies = buildMulticaDispatchDependencies(config, ['/tmp/allowed']);

    expect(dependencies.target).toEqual({
      workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
      projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
    });
    expect(dependencies.allowedContextRoots).toEqual(['/tmp/allowed']);
    expect(dependencies.connector).toBeDefined();
    expect(typeof dependencies.connector.ensureIssue).toBe('function');
  });

  it('supports the empty allowlist used by the plugin process', () => {
    const config = loadConfig({ ATL_VAULT_ROOT: '/tmp/vault' });
    const dependencies = buildMulticaDispatchDependencies(config, []);
    expect(dependencies.allowedContextRoots).toEqual([]);
  });
});

describe('buildResearchMulticaDispatchDependencies (PAW-GOAL-005-T2)', () => {
  it('binds the production Research Agent and stores evidence under the Vault', () => {
    const config = loadConfig({
      ATL_VAULT_ROOT: '/tmp/vault',
      ATL_MULTICA_WORKSPACE_ID: '89440e05-518e-4c7e-aa80-0afa2be21196',
      ATL_MULTICA_PROJECT_ID: 'b70aeddc-4a32-47ed-a288-571f5475634a',
    });
    let connectorOptions: MulticaCliConnectorOptions | null = null;
    const connector = {
      ensureIssue: async () => ({ status: 'failed' as const, reason: 'not called' }),
      inspect: async () => { throw new Error('not called'); },
      runs: async () => [],
      listComments: async () => ({ comments: [] }),
    };

    const dependencies = buildResearchMulticaDispatchDependencies(
      config,
      ['/tmp/allowed', '/tmp/vault'],
      {
        connectorFactory: (options) => {
          connectorOptions = options;
          return connector;
        },
      },
    );

    expect(connectorOptions).toMatchObject({
      workspaceId: config.multicaDispatch.workspaceId,
      projectId: config.multicaDispatch.projectId,
      assignment: {
        type: 'agent',
        id: RESEARCH_AGENT_ID,
        requiredModel: RESEARCH_AGENT_MODEL,
        requiredMaxConcurrentTasks: RESEARCH_AGENT_MAX_CONCURRENT_TASKS,
      },
    });
    expect(RESEARCH_AGENT_MODEL).toBe('gpt-5.6-sol');
    expect(RESEARCH_AGENT_MAX_CONCURRENT_TASKS).toBe(10);
    expect(dependencies.runtimeRoot).toBe('/tmp/vault/.atl-runtime');
    expect(dependencies.contextBaseRoot).toBe('/tmp/vault');
    expect(dependencies.allowedContextRoots).toEqual(['/tmp/vault', '/tmp/allowed']);
    expect(dependencies.connector).toBe(connector);
  });
});
