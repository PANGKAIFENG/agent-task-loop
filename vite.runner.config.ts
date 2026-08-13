import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { copyFile } from 'node:fs/promises';

import { defineConfig } from 'vite';

const nodeModules = new Set([
  ...builtinModules,
  ...builtinModules.map((module) => `node:${module}`),
]);

export default defineConfig({
  plugins: [{
    name: 'copy-dingtalk-bridge',
    async closeBundle() {
      await copyFile(
        resolve('scripts/atl-dingtalk-bridge.mjs'),
        resolve('build/obsidian-plugin/atl-dingtalk-bridge.mjs'),
      );
    },
  }],
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve('src/cli.ts'),
      formats: ['es'],
      fileName: () => 'atl-runner.mjs',
    },
    minify: false,
    outDir: resolve('build/obsidian-plugin'),
    rollupOptions: {
      external: (id) => nodeModules.has(id),
      output: {
        banner: [
          "import { createRequire as __atlCreateRequire } from 'node:module';",
          'const require = __atlCreateRequire(import.meta.url);',
        ].join('\n'),
      },
    },
    sourcemap: true,
    target: 'node24',
  },
});
