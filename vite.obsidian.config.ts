import { copyFileSync, mkdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';

const outputDirectory = resolve('build/obsidian-plugin');
const nodeModules = new Set([
  ...builtinModules,
  ...builtinModules.map((module) => `node:${module}`),
]);

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve('src/obsidian-plugin/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    minify: false,
    outDir: outputDirectory,
    rollupOptions: {
      external: (id) => id === 'obsidian'
        || id === 'electron'
        || nodeModules.has(id),
      output: {
        assetFileNames: (asset) => asset.name?.endsWith('.css') === true
          ? 'styles.css'
          : '[name][extname]',
        exports: 'default',
      },
    },
    sourcemap: true,
    target: 'es2022',
  },
  plugins: [{
    name: 'copy-obsidian-manifest',
    closeBundle() {
      mkdirSync(outputDirectory, { recursive: true });
      copyFileSync(
        resolve('src/obsidian-plugin/manifest.json'),
        resolve(outputDirectory, 'manifest.json'),
      );
    },
  }],
});
