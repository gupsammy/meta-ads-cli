import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    entry: { services: 'src/services/index.ts' },
    format: ['esm'],
    dts: true,
    clean: false,
    sourcemap: true,
  },
]);
