import { defineConfig } from 'vite';

// The demo lives in `demo/` and imports the SDK directly from `../src`.
// The SDK distribution build is handled by tsup — see `tsup.config.ts`.
export default defineConfig({
  root: 'demo',
  build: {
    target: 'es2022',
    outDir: '../demo-dist',
    emptyOutDir: true,
  },
});
