import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: 'neutral',
  deps: {
    neverBundle: ['@bjorn3/browser_wasi_shim'],
  },
});
