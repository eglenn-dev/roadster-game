import { defineConfig } from 'vitest/config';

// The app renders with the WebGPU build of three.js. Aliasing the bare `three`
// specifier to it keeps a single copy of the library in the bundle (addons
// import from `three`). Tests run the physics headless against core `three`.
export default defineConfig({
  resolve: {
    alias: process.env.VITEST ? [] : [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: 'node',
  },
});
