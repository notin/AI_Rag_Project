import { defineConfig } from 'vitest/config';
import { config as loadEnv } from 'dotenv';
import path from 'path';

// `.env` lives at the monorepo root, but vitest runs with this package as cwd —
// so load it by absolute path rather than relying on dotenv's cwd lookup.
const { parsed } = loadEnv({ path: path.resolve(__dirname, '../../.env') });

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*integration.test.ts'],
    testTimeout: 60_000, // embedding calls can be slow
    // Integration tests share one live database; running files in parallel
    // would let their fixtures and the GC pass interleave.
    fileParallelism: false,
    env: parsed ?? {},
  },
  resolve: {
    alias: {
      '@app/shared': path.resolve(__dirname, '../shared/src'),
      '@app/llm-client': path.resolve(__dirname, '../llm-client/src'),
    },
  },
});
