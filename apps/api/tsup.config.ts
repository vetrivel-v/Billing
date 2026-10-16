import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // Bundle workspace packages (they export TypeScript source); keep third-party deps external.
  noExternal: [/^@commercebill\//],
});
