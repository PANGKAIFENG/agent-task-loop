import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';

const nodeModules = new Set([
  ...builtinModules,
  ...builtinModules.map((module) => `node:${module}`),
]);

export default defineConfig({
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'main'],
  },
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve('src/dingtalk-bot-stream-entry.ts'),
      formats: ['es'],
      fileName: () => 'atl-dingtalk-stream.mjs',
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
