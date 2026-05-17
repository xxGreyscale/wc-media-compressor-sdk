import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // Emitted as a separate file so the main bundle can spawn it via
    // `new Worker(new URL('./hevc-decoder-worker.js', import.meta.url))`.
    // Consumer bundlers (Vite, webpack 5, Parcel) understand that pattern
    // and emit the worker as a discoverable asset alongside `index.js`.
    'hevc-decoder-worker': 'src/video/hevc-decoder-worker.ts',
  },
  format: ['esm', 'cjs'],
  // dts is handled by tsc (emitDeclarationOnly) — gives accurate .d.ts.map support
  dts: false,
  clean: false,
  // mp4box is bundled: it's a small runtime dep consumers shouldn't need to install separately
  noExternal: ['mp4box'],
  treeshake: true,
  sourcemap: true,
});
