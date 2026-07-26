import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsHooks = vi.hoisted(() => ({
  beforeTaskNotesAtomicWrite: undefined as (() => Promise<void>) | undefined,
  beforeDataInstall: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (typeof args[0] === 'string' && args[0].includes('.atl-tasknotes-fields-')) {
        const hook = fsHooks.beforeTaskNotesAtomicWrite;
        fsHooks.beforeTaskNotesAtomicWrite = undefined;
        await hook?.();
      }
      return handle;
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (typeof args[0] === 'string' && args[0].includes('.atl-tasknotes-fields-')) {
        const hook = fsHooks.beforeDataInstall;
        fsHooks.beforeDataInstall = undefined;
        await hook?.();
      }
      return fs.rename(...args);
    },
    link: async (...args: Parameters<typeof fs.link>) => {
      if (typeof args[0] === 'string' && args[0].includes('.atl-tasknotes-fields-')) {
        const hook = fsHooks.beforeDataInstall;
        fsHooks.beforeDataInstall = undefined;
        await hook?.();
      }
      return fs.link(...args);
    },
  };
});

import {
  GOVERNED_TASKNOTES_FIELD_IDS,
  TASKNOTES_DATA_PATH,
  TASKNOTES_FIELD_LAYOUT_BACKUP_PATH,
  TaskNotesFieldGovernanceController,
} from '../../../src/obsidian-plugin/tasknotes-field-governance-controller.js';

const roots: string[] = [];

type Field = Record<string, unknown> & { id: string };
type TaskNotesConfig = {
  modalFieldsConfig: {
    version: number;
    fields: Field[];
    userFields: Array<Record<string, unknown>>;
  };
  [key: string]: unknown;
};

function taskNotesConfig(): TaskNotesConfig {
  return {
    generalSetting: { keep: 'unchanged' },
    modalFieldsConfig: {
      version: 1,
      userFields: [{ id: 'custom', label: 'Custom field' }],
      fields: [
        ...GOVERNED_TASKNOTES_FIELD_IDS.map((id, index) => ({
          id,
          displayName: `Field ${index}`,
          type: 'text',
          enabled: true,
          visibleInCreation: index % 2 === 0,
          visibleInEdit: index % 2 !== 0,
          preserved: { index },
        })),
        {
          id: 'atl_origin',
          displayName: 'Origin',
          type: 'text',
          enabled: true,
          visibleInCreation: true,
          visibleInEdit: true,
        },
      ],
    },
  };
}

async function fixture(config = taskNotesConfig()) {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'atl-tasknotes-fields-'));
  roots.push(vaultRoot);
  const dataPath = join(vaultRoot, TASKNOTES_DATA_PATH);
  const backupPath = join(vaultRoot, TASKNOTES_FIELD_LAYOUT_BACKUP_PATH);
  await mkdir(dirname(dataPath), { recursive: true });
  await writeFile(dataPath, JSON.stringify(config, null, 2), 'utf8');
  return { vaultRoot, dataPath, backupPath, config };
}

async function transactionArtifacts(dataPath: string): Promise<string[]> {
  return (await readdir(dirname(dataPath))).filter((name) => name.startsWith('.atl-tasknotes-'));
}

afterEach(async () => {
  fsHooks.beforeTaskNotesAtomicWrite = undefined;
  fsHooks.beforeDataInstall = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('TaskNotesFieldGovernanceController', () => {
  it('hides exactly the governed field visibility flags and writes a selective backup', async () => {
    const paths = await fixture();
    const controller = new TaskNotesFieldGovernanceController();

    await controller.applyPreset(paths.vaultRoot);

    const updated = JSON.parse(await readFile(paths.dataPath, 'utf8')) as TaskNotesConfig;
    const originalFields = paths.config.modalFieldsConfig.fields;
    for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
      const field = updated.modalFieldsConfig.fields.find((candidate) => candidate.id === id);
      const original = originalFields.find((candidate) => candidate.id === id);
      expect(field).toEqual({
        ...original,
        visibleInCreation: false,
        visibleInEdit: false,
      });
    }
    expect(updated.modalFieldsConfig.fields.find((field) => field.id === 'atl_origin')).toEqual(
      paths.config.modalFieldsConfig.fields.find((field) => field.id === 'atl_origin'),
    );
    expect(updated.modalFieldsConfig.userFields).toEqual(paths.config.modalFieldsConfig.userFields);
    expect(updated.generalSetting).toEqual(paths.config.generalSetting);

    expect(JSON.parse(await readFile(paths.backupPath, 'utf8'))).toEqual({
      version: 1,
      fields: Object.fromEntries(GOVERNED_TASKNOTES_FIELD_IDS.map((id) => [id, {
        visibleInCreation: paths.config.modalFieldsConfig.fields.find(
          (field) => field.id === id,
        )?.visibleInCreation,
        visibleInEdit: paths.config.modalFieldsConfig.fields.find(
          (field) => field.id === id,
        )?.visibleInEdit,
      }])),
    });
  });

  it('restores only governed visibility pairs after unrelated TaskNotes settings change', async () => {
    const paths = await fixture();
    const controller = new TaskNotesFieldGovernanceController();
    await controller.applyPreset(paths.vaultRoot);

    const changed = JSON.parse(await readFile(paths.dataPath, 'utf8')) as TaskNotesConfig;
    changed.generalSetting = { keep: 'changed later' };
    const retained = changed.modalFieldsConfig.fields.find((field) => field.id === 'atl_origin');
    if (retained === undefined) throw new Error('missing retained field');
    retained.displayName = 'Renamed later';
    await writeFile(paths.dataPath, JSON.stringify(changed, null, 2), 'utf8');

    await controller.restorePreset(paths.vaultRoot);

    const restored = JSON.parse(await readFile(paths.dataPath, 'utf8')) as TaskNotesConfig;
    expect(restored.generalSetting).toEqual({ keep: 'changed later' });
    expect(restored.modalFieldsConfig.fields.find((field) => field.id === 'atl_origin')).toMatchObject({
      displayName: 'Renamed later',
    });
    for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
      const restoredField = restored.modalFieldsConfig.fields.find((field) => field.id === id);
      const originalField = paths.config.modalFieldsConfig.fields.find((field) => field.id === id);
      expect(restoredField).toBeDefined();
      expect(originalField).toBeDefined();
      expect(restoredField).toMatchObject(originalField!);
    }
  });

  it('preserves the first selective backup when reapplied', async () => {
    const paths = await fixture();
    const controller = new TaskNotesFieldGovernanceController();
    await controller.applyPreset(paths.vaultRoot);
    const firstBackup = await readFile(paths.backupPath, 'utf8');

    await controller.applyPreset(paths.vaultRoot);

    expect(await readFile(paths.backupPath, 'utf8')).toBe(firstBackup);
    await expect(controller.status(paths.vaultRoot)).resolves.toEqual({
      available: true,
      applied: true,
      restorable: true,
    });
  });

  it('removes a failed apply attempt backup when TaskNotes changes its data after ATL reads it', async () => {
    const paths = await fixture();
    const original = await readFile(paths.dataPath, 'utf8');
    const taskNotesChange = JSON.parse(original) as TaskNotesConfig;
    taskNotesChange.generalSetting = { keep: 'changed by TaskNotes' };
    fsHooks.beforeTaskNotesAtomicWrite = async () => {
      await writeFile(paths.dataPath, JSON.stringify(taskNotesChange, null, 2), 'utf8');
    };
    const controller = new TaskNotesFieldGovernanceController();

    await expect(controller.applyPreset(paths.vaultRoot)).rejects.toThrow(
      'TaskNotes 配置已变更，请重试',
    );
    expect(await readFile(paths.dataPath, 'utf8')).toBe(JSON.stringify(taskNotesChange, null, 2));
    await expect(readFile(paths.backupPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await transactionArtifacts(paths.dataPath)).toEqual([]);
  });

  it('uses the retry visibility snapshot after a failed apply attempt', async () => {
    const paths = await fixture();
    const initial = await readFile(paths.dataPath, 'utf8');
    const taskNotesChange = JSON.parse(initial) as TaskNotesConfig;
    const tags = taskNotesChange.modalFieldsConfig.fields.find((field) => field.id === 'tags');
    if (tags === undefined) throw new Error('missing tags field');
    tags.visibleInCreation = true;
    tags.visibleInEdit = false;
    fsHooks.beforeTaskNotesAtomicWrite = async () => {
      await writeFile(paths.dataPath, JSON.stringify(taskNotesChange, null, 2), 'utf8');
    };
    const controller = new TaskNotesFieldGovernanceController();

    await expect(controller.applyPreset(paths.vaultRoot)).rejects.toThrow(
      'TaskNotes 配置已变更，请重试',
    );
    await controller.applyPreset(paths.vaultRoot);
    await controller.restorePreset(paths.vaultRoot);

    const restored = JSON.parse(await readFile(paths.dataPath, 'utf8')) as TaskNotesConfig;
    expect(restored.modalFieldsConfig.fields.find((field) => field.id === 'tags')).toMatchObject({
      visibleInCreation: true,
      visibleInEdit: false,
    });
  });

  it('rejects restore when TaskNotes changes its data after ATL reads it', async () => {
    const paths = await fixture();
    const controller = new TaskNotesFieldGovernanceController();
    await controller.applyPreset(paths.vaultRoot);
    const taskNotesChange = JSON.parse(await readFile(paths.dataPath, 'utf8')) as TaskNotesConfig;
    taskNotesChange.generalSetting = { keep: 'changed by TaskNotes' };
    fsHooks.beforeTaskNotesAtomicWrite = async () => {
      await writeFile(paths.dataPath, JSON.stringify(taskNotesChange, null, 2), 'utf8');
    };

    await expect(controller.restorePreset(paths.vaultRoot)).rejects.toThrow(
      'TaskNotes 配置已变更，请重试',
    );
    expect(await readFile(paths.dataPath, 'utf8')).toBe(JSON.stringify(taskNotesChange, null, 2));
    expect(await transactionArtifacts(paths.dataPath)).toEqual([]);
  });

  it('preserves a pre-existing backup when a later apply attempt conflicts', async () => {
    const paths = await fixture();
    const controller = new TaskNotesFieldGovernanceController();
    await controller.applyPreset(paths.vaultRoot);
    const firstBackup = await readFile(paths.backupPath, 'utf8');
    const taskNotesChange = JSON.parse(await readFile(paths.dataPath, 'utf8')) as TaskNotesConfig;
    taskNotesChange.generalSetting = { keep: 'changed by TaskNotes' };
    fsHooks.beforeTaskNotesAtomicWrite = async () => {
      await writeFile(paths.dataPath, JSON.stringify(taskNotesChange, null, 2), 'utf8');
    };

    await expect(controller.applyPreset(paths.vaultRoot)).rejects.toThrow(
      'TaskNotes 配置已变更，请重试',
    );
    expect(await readFile(paths.backupPath, 'utf8')).toBe(firstBackup);
  });

  it('does not overwrite a TaskNotes save in the final apply installation window', async () => {
    const paths = await fixture();
    const taskNotesChange = JSON.parse(await readFile(paths.dataPath, 'utf8')) as TaskNotesConfig;
    taskNotesChange.generalSetting = { keep: 'saved during installation' };
    fsHooks.beforeDataInstall = async () => {
      await writeFile(paths.dataPath, JSON.stringify(taskNotesChange, null, 2), 'utf8');
    };
    const controller = new TaskNotesFieldGovernanceController();

    await expect(controller.applyPreset(paths.vaultRoot)).rejects.toThrow(
      'TaskNotes 配置已变更，请重试',
    );
    expect(await readFile(paths.dataPath, 'utf8')).toBe(JSON.stringify(taskNotesChange, null, 2));
  });

  it('does not overwrite a TaskNotes save in the final restore installation window', async () => {
    const paths = await fixture();
    const controller = new TaskNotesFieldGovernanceController();
    await controller.applyPreset(paths.vaultRoot);
    const taskNotesChange = JSON.parse(await readFile(paths.dataPath, 'utf8')) as TaskNotesConfig;
    taskNotesChange.generalSetting = { keep: 'saved during installation' };
    fsHooks.beforeDataInstall = async () => {
      await writeFile(paths.dataPath, JSON.stringify(taskNotesChange, null, 2), 'utf8');
    };

    await expect(controller.restorePreset(paths.vaultRoot)).rejects.toThrow(
      'TaskNotes 配置已变更，请重试',
    );
    expect(await readFile(paths.dataPath, 'utf8')).toBe(JSON.stringify(taskNotesChange, null, 2));
  });

  it('reports applied only while every governed visibility pair is false', async () => {
    const paths = await fixture();
    const controller = new TaskNotesFieldGovernanceController();
    await controller.applyPreset(paths.vaultRoot);
    const changed = JSON.parse(await readFile(paths.dataPath, 'utf8')) as TaskNotesConfig;
    const field = changed.modalFieldsConfig.fields.find((candidate) => candidate.id === 'tags');
    if (field === undefined) throw new Error('missing tags field');
    field.visibleInEdit = true;
    await writeFile(paths.dataPath, JSON.stringify(changed, null, 2), 'utf8');

    await expect(controller.status(paths.vaultRoot)).resolves.toEqual({
      available: true,
      applied: false,
      restorable: true,
    });
  });

  it('reports unavailable without creating a TaskNotes configuration', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'atl-tasknotes-missing-'));
    roots.push(vaultRoot);
    const controller = new TaskNotesFieldGovernanceController();

    await expect(controller.status(vaultRoot)).resolves.toEqual({
      available: false,
      applied: false,
      restorable: false,
    });
    await expect(controller.applyPreset(vaultRoot)).rejects.toThrow('未找到 TaskNotes 数据配置');
    await expect(readFile(join(vaultRoot, TASKNOTES_DATA_PATH), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['unsupported version', JSON.stringify({
      modalFieldsConfig: { version: 2, fields: [] },
    })],
  ])('rejects %s without creating a backup or changing TaskNotes data', async (_name, content) => {
    const paths = await fixture();
    await writeFile(paths.dataPath, content, 'utf8');
    const controller = new TaskNotesFieldGovernanceController();

    await expect(controller.applyPreset(paths.vaultRoot)).rejects.toThrow(
      'TaskNotes 字段配置无效或版本不受支持',
    );
    expect(await readFile(paths.dataPath, 'utf8')).toBe(content);
    await expect(readFile(paths.backupPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['duplicate governed field', (config: TaskNotesConfig) => {
      config.modalFieldsConfig.fields.push({
        ...config.modalFieldsConfig.fields[0]!,
      });
    }],
    ['missing governed field', (config: TaskNotesConfig) => {
      config.modalFieldsConfig.fields = config.modalFieldsConfig.fields.filter(
        (field) => field.id !== 'tags',
      );
    }],
    ['non-boolean visibility', (config: TaskNotesConfig) => {
      const field = config.modalFieldsConfig.fields.find((candidate) => candidate.id === 'tags');
      if (field === undefined) throw new Error('missing tags field');
      field.visibleInEdit = 'yes';
    }],
  ])('rejects %s without partial writes', async (_name, mutate) => {
    const config = taskNotesConfig();
    mutate(config);
    const paths = await fixture(config);
    const original = await readFile(paths.dataPath, 'utf8');
    const controller = new TaskNotesFieldGovernanceController();

    await expect(controller.applyPreset(paths.vaultRoot)).rejects.toThrow(
      'TaskNotes 字段配置无效或版本不受支持',
    );
    expect(await readFile(paths.dataPath, 'utf8')).toBe(original);
    await expect(readFile(paths.backupPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects restore with no backup and keeps TaskNotes data unchanged', async () => {
    const paths = await fixture();
    const original = await readFile(paths.dataPath, 'utf8');
    const controller = new TaskNotesFieldGovernanceController();

    await expect(controller.restorePreset(paths.vaultRoot)).rejects.toThrow(
      '没有可恢复的 ATL 字段布局备份',
    );
    expect(await readFile(paths.dataPath, 'utf8')).toBe(original);
  });

  it('fails closed on malformed backups and does not alter TaskNotes data', async () => {
    const paths = await fixture();
    const controller = new TaskNotesFieldGovernanceController();
    await mkdir(dirname(paths.backupPath), { recursive: true });
    await writeFile(paths.backupPath, JSON.stringify({ version: 1, fields: {} }), 'utf8');
    const original = await readFile(paths.dataPath, 'utf8');

    await expect(controller.status(paths.vaultRoot)).resolves.toEqual({
      available: true,
      applied: false,
      restorable: false,
    });
    await expect(controller.applyPreset(paths.vaultRoot)).rejects.toThrow('ATL 字段布局备份无效');
    await expect(controller.restorePreset(paths.vaultRoot)).rejects.toThrow('ATL 字段布局备份无效');
    expect(await readFile(paths.dataPath, 'utf8')).toBe(original);
  });

  it('rejects a TaskNotes data path that escapes the Vault through a symlink', async () => {
    const paths = await fixture();
    const outsideRoot = await mkdtemp(join(tmpdir(), 'atl-tasknotes-outside-'));
    roots.push(outsideRoot);
    const outsidePath = join(outsideRoot, 'data.json');
    const outsideContent = await readFile(paths.dataPath, 'utf8');
    await writeFile(outsidePath, outsideContent, 'utf8');
    await rm(paths.dataPath);
    await symlink(outsidePath, paths.dataPath);
    const controller = new TaskNotesFieldGovernanceController();

    await expect(controller.applyPreset(paths.vaultRoot)).rejects.toThrow('TaskNotes 数据文件不安全');
    expect(await readFile(outsidePath, 'utf8')).toBe(outsideContent);
    await expect(readFile(paths.backupPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a TaskNotes parent directory symlink even when its target remains in the Vault', async () => {
    const paths = await fixture();
    const taskNotesDirectory = dirname(paths.dataPath);
    const targetDirectory = join(paths.vaultRoot, 'real-tasknotes');
    const targetPath = join(targetDirectory, 'data.json');
    const targetContent = await readFile(paths.dataPath, 'utf8');
    await mkdir(targetDirectory);
    await writeFile(targetPath, targetContent, 'utf8');
    await rm(taskNotesDirectory, { recursive: true, force: true });
    await symlink(targetDirectory, taskNotesDirectory);
    const controller = new TaskNotesFieldGovernanceController();

    await expect(controller.applyPreset(paths.vaultRoot)).rejects.toThrow('TaskNotes 数据文件不安全');
    expect(await readFile(targetPath, 'utf8')).toBe(targetContent);
    await expect(readFile(paths.backupPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
