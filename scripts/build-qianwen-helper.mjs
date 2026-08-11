/* global process */

import { chmod, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

if (process.platform !== 'darwin') process.exit(0);

const outputDirectory = join(process.cwd(), 'build', 'obsidian-plugin');
const output = join(outputDirectory, 'qianwen-accessibility-helper');
await mkdir(outputDirectory, { recursive: true });

await new Promise((resolve, reject) => {
  const child = spawn('/usr/bin/xcrun', [
    'clang',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-fobjc-arc',
    '-framework',
    'AppKit',
    '-framework',
    'ApplicationServices',
    '-framework',
    'CoreGraphics',
    '-framework',
    'ScreenCaptureKit',
    '-framework',
    'Vision',
    '-o',
    output,
    join(process.cwd(), 'native', 'qianwen-accessibility-helper.m'),
  ], { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`Qianwen helper compilation failed with exit code ${String(code)}`));
  });
});
await chmod(output, 0o755);
