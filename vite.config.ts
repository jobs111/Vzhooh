import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
export default defineConfig({
  base: './',
  define: { __VER__: JSON.stringify(pkg.version) },
  build: { target: 'es2020', modulePreload: false, assetsInlineLimit: 0 },
});
