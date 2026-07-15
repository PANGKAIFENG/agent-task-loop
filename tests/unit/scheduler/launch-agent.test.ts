import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectLaunchAgent,
  installLaunchAgent,
  LAUNCH_AGENT_LABEL,
  type LaunchAgentCommandAdapter,
  renderLaunchAgent,
  uninstallLaunchAgent,
} from '../../../src/scheduler/launch-agent.js';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atl-launch-agent-'));
  roots.push(root);
  const home = join(root, 'home');
  const repositoryRoot = join(root, 'repo & source');
  const vaultRoot = join(root, 'vault <research>');
  const allowedRoot = join(root, 'allowed "sources"');
  const claudeConfigDir = join(root, 'claude config');
  const claudeBinary = join(root, "claude's bin");
  const cliPath = join(repositoryRoot, 'build', 'server', 'cli.js');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(join(repositoryRoot, 'build', 'server'), { recursive: true }),
    mkdir(vaultRoot, { recursive: true }),
    mkdir(allowedRoot, { recursive: true }),
    mkdir(claudeConfigDir, { recursive: true }),
  ]);
  await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
  await writeFile(claudeBinary, '#!/bin/sh\n', 'utf8');
  await chmod(claudeBinary, 0o700);
  return {
    root,
    home,
    repositoryRoot,
    vaultRoot,
    allowedRoot,
    claudeConfigDir,
    claudeBinary,
    cliPath,
  };
}

function commandRecorder(failAt?: 'lint' | 'bootstrap' | 'bootout') {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const adapter: LaunchAgentCommandAdapter = {
    async execute(command, args) {
      calls.push({ command, args });
      if (
        (failAt === 'lint' && command === '/usr/bin/plutil')
        || (failAt === 'bootstrap' && args[0] === 'bootstrap')
        || (failAt === 'bootout' && args[0] === 'bootout')
      ) {
        throw new Error(`${failAt} failed`);
      }
      return { stdout: '', stderr: '' };
    },
  };
  return { adapter, calls };
}

function renderOptions(paths: Awaited<ReturnType<typeof fixture>>) {
  return {
    environment: {
      ATL_VAULT_ROOT: paths.vaultRoot,
      ATL_CLAUDE_BIN: paths.claudeBinary,
      ATL_CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
      ATL_CLAUDE_MODEL: 'glm-4-flash',
      ATL_ALLOWED_LOCAL_ROOTS: paths.allowedRoot,
      ATL_DAILY_LIMIT: '2',
    },
    homeDirectory: paths.home,
    nodeExecutable: process.execPath,
    repositoryRoot: paths.repositoryRoot,
    systemTimeZone: () => 'Asia/Shanghai',
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('renderLaunchAgent', () => {
  it('renders one bounded secret-free Asia/Shanghai runner schedule', async () => {
    const paths = await fixture();
    const rendered = await renderLaunchAgent({
      ...renderOptions(paths),
      environment: {
        ...renderOptions(paths).environment,
        PROVIDER_API_TOKEN: 'SECRET_SENTINEL',
        TASK_BODY: 'REAL_TASK_SENTINEL',
      },
    });
    const canonical = {
      home: await realpath(paths.home),
      repositoryRoot: await realpath(paths.repositoryRoot),
      vaultRoot: await realpath(paths.vaultRoot),
      allowedRoot: await realpath(paths.allowedRoot),
      claudeBinary: await realpath(paths.claudeBinary),
      claudeConfigDir: await realpath(paths.claudeConfigDir),
      cliPath: await realpath(paths.cliPath),
    };

    expect(rendered.label).toBe(LAUNCH_AGENT_LABEL);
    expect(rendered.programArguments).toEqual([
      await realpath(process.execPath),
      canonical.cliPath,
      'runner',
      'run-once',
      '--driver',
      'claude',
    ]);
    expect(rendered.workingDirectory).toBe(canonical.repositoryRoot);
    expect(rendered.standardOutPath).toBe(join(
      canonical.home,
      '.local',
      'state',
      'agent-task-loop',
      'runner.stdout.log',
    ));
    expect(rendered.standardErrorPath).toBe(join(
      canonical.home,
      '.local',
      'state',
      'agent-task-loop',
      'runner.stderr.log',
    ));
    expect(rendered.environmentVariables).toEqual({
      ATL_VAULT_ROOT: canonical.vaultRoot,
      ATL_ALLOW_REAL_WRITES: '1',
      ATL_AGENT_DRIVER: 'claude',
      ATL_CLAUDE_BIN: canonical.claudeBinary,
      ATL_CLAUDE_CONFIG_DIR: canonical.claudeConfigDir,
      ATL_CLAUDE_MODEL: 'glm-4-flash',
      ATL_ALLOWED_LOCAL_ROOTS: canonical.allowedRoot,
      ATL_DAILY_LIMIT: '2',
      HOME: canonical.home,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    });

    expect(rendered.plist).toContain('<string>ai.agent-task-loop.runner</string>');
    expect(rendered.plist).toContain('repo &amp; source');
    expect(rendered.plist).toContain('vault &lt;research&gt;');
    expect(rendered.plist).toContain('allowed &quot;sources&quot;');
    expect(rendered.plist).toContain('claude&apos;s bin');
    expect(rendered.plist).not.toContain('RunAtLoad');
    expect(rendered.plist).not.toContain('SECRET_SENTINEL');
    expect(rendered.plist).not.toContain('REAL_TASK_SENTINEL');
    expect(rendered.plist.match(/<key>Hour<\/key>/g)).toHaveLength(15);
    expect(rendered.plist.match(/<integer>(?:8|9|1\d|2[0-2])<\/integer>/g))
      .toHaveLength(15);
    expect(rendered.plist.match(/<key>Minute<\/key>\s*<integer>0<\/integer>/g))
      .toHaveLength(15);
    expect(rendered.environmentVariables.ATL_ALLOWED_LOCAL_ROOTS.split(delimiter))
      .toEqual([canonical.allowedRoot]);
  });

  it('rejects rendering outside Asia/Shanghai before resolving runtime paths', async () => {
    await expect(renderLaunchAgent({
      environment: {},
      homeDirectory: '/missing/home',
      repositoryRoot: '/missing/repo',
      systemTimeZone: () => 'UTC',
    })).rejects.toThrow('System timezone must be Asia/Shanghai');
  });
});

describe('LaunchAgent lifecycle', () => {
  it('atomically installs the exact plist before lint and bootstrap', async () => {
    const paths = await fixture();
    const commands = commandRecorder();

    const result = await installLaunchAgent({
      ...renderOptions(paths),
      commandAdapter: commands.adapter,
      uid: 501,
    });

    expect(result).toMatchObject({
      installed: true,
      managed: true,
      label: LAUNCH_AGENT_LABEL,
    });
    const expectedPath = join(
      await realpath(paths.home),
      'Library',
      'LaunchAgents',
      `${LAUNCH_AGENT_LABEL}.plist`,
    );
    expect(result.path).toBe(expectedPath);
    expect((await stat(expectedPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(expectedPath, 'utf8')).toContain(
      `<string>${LAUNCH_AGENT_LABEL}</string>`,
    );
    expect(commands.calls).toEqual([
      { command: '/usr/bin/plutil', args: ['-lint', expectedPath] },
      {
        command: '/bin/launchctl',
        args: ['bootstrap', 'gui/501', expectedPath],
      },
    ]);
    expect(await readdir(join(paths.home, '.local', 'state', 'agent-task-loop')))
      .toEqual([]);
  });

  it('refuses a different structured Label even if the managed label appears elsewhere', async () => {
    const paths = await fixture();
    const commands = commandRecorder();
    const launchAgents = join(paths.home, 'Library', 'LaunchAgents');
    const path = join(launchAgents, `${LAUNCH_AGENT_LABEL}.plist`);
    const existing = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>Label</key><string>com.example.user-job</string>',
      '<key>ProgramArguments</key><array>',
      `<string>${LAUNCH_AGENT_LABEL}</string>`,
      '</array></dict></plist>',
    ].join('\n');
    await mkdir(launchAgents, { recursive: true });
    await writeFile(path, existing, { mode: 0o600 });

    await expect(installLaunchAgent({
      ...renderOptions(paths),
      commandAdapter: commands.adapter,
      uid: 501,
    })).rejects.toThrow('different Label');

    expect(await readFile(path, 'utf8')).toBe(existing);
    expect(commands.calls).toEqual([]);
  });

  it.each(['lint', 'bootstrap'] as const)(
    'removes only its newly written plist when %s fails',
    async (failure) => {
      const paths = await fixture();
      const commands = commandRecorder(failure);
      const path = join(
        paths.home,
        'Library',
        'LaunchAgents',
        `${LAUNCH_AGENT_LABEL}.plist`,
      );

      await expect(installLaunchAgent({
        ...renderOptions(paths),
        commandAdapter: commands.adapter,
        uid: 501,
      })).rejects.toThrow(`${failure} failed`);

      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('restores an existing managed plist when bootstrap fails', async () => {
    const paths = await fixture();
    const commands = commandRecorder('bootstrap');
    const launchAgents = join(paths.home, 'Library', 'LaunchAgents');
    const path = join(launchAgents, `${LAUNCH_AGENT_LABEL}.plist`);
    const previous = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      `<key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>`,
      '<key>Previous</key><true/>',
      '</dict></plist>',
    ].join('\n');
    await mkdir(launchAgents, { recursive: true });
    await writeFile(path, previous, { mode: 0o600 });

    await expect(installLaunchAgent({
      ...renderOptions(paths),
      commandAdapter: commands.adapter,
      uid: 501,
    })).rejects.toThrow('bootstrap failed');

    expect(await readFile(path, 'utf8')).toBe(previous);
  });

  it('inspects without creating the LaunchAgents directory or invoking commands', async () => {
    const paths = await fixture();

    await expect(inspectLaunchAgent({ homeDirectory: paths.home }))
      .resolves.toMatchObject({
        installed: false,
        managed: false,
        label: null,
      });
    await expect(lstat(join(paths.home, 'Library')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('boots out and removes only the unchanged exact managed file', async () => {
    const paths = await fixture();
    const commands = commandRecorder();
    const installed = await installLaunchAgent({
      ...renderOptions(paths),
      commandAdapter: commands.adapter,
      uid: 501,
    });
    commands.calls.splice(0);

    const result = await uninstallLaunchAgent({
      homeDirectory: paths.home,
      commandAdapter: commands.adapter,
      uid: 501,
    });

    expect(result).toMatchObject({ installed: false, managed: true });
    expect(commands.calls).toEqual([{
      command: '/bin/launchctl',
      args: ['bootout', 'gui/501', installed.path],
    }]);
    await expect(lstat(installed.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not boot out or remove a different existing Label', async () => {
    const paths = await fixture();
    const commands = commandRecorder();
    const launchAgents = join(paths.home, 'Library', 'LaunchAgents');
    const path = join(launchAgents, `${LAUNCH_AGENT_LABEL}.plist`);
    const existing = '<plist><dict><key>Label</key><string>user.job</string></dict></plist>';
    await mkdir(launchAgents, { recursive: true });
    await writeFile(path, existing, { mode: 0o600 });

    await expect(uninstallLaunchAgent({
      homeDirectory: paths.home,
      commandAdapter: commands.adapter,
      uid: 501,
    })).rejects.toThrow('different Label');

    expect(commands.calls).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(existing);
  });
});
