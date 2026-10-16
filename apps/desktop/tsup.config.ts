import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', preload: 'src/preload.ts' },
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  target: 'node22',
  outDir: 'dist',
  clean: true,
  external: ['electron'],
  noExternal: [/^@commercebill\//],
});
