import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', preload: 'src/preload.ts' },
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // Everything is bundled into main.cjs so the installed application needs no node_modules (pg-native is an optional addon pg never needs).
  external: ['electron', 'pg-native'],
  noExternal: [/^@commercebill\//, 'pg'],
});
