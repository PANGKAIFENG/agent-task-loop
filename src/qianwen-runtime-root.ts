import { dirname, join } from 'node:path';

export interface QianwenRuntimeRootInput {
  cwd?: string;
  runnerPath?: string;
}

export function qianwenRuntimeRoot(input: QianwenRuntimeRootInput): string {
  const pluginRoot = input.runnerPath === undefined
    ? input.cwd
    : dirname(input.runnerPath);
  if (pluginRoot === undefined || pluginRoot.trim() === '') {
    throw new Error('千问运行目录无法确定');
  }
  return join(pluginRoot, '.atl-runtime');
}
