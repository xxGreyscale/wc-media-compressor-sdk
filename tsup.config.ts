import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  // dts is handled by tsc (emitDeclarationOnly) — gives accurate .d.ts.map support
  dts: false,
  clean: false,
  // mp4box is bundled: it's a small runtime dep consumers shouldn't need to install separately
  noExternal: ['mp4box'],
  treeshake: true,
  sourcemap: true,
});
