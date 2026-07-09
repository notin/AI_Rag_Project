import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/__tests__/integration.test.ts'],
  },
  resolve: {
    alias: {
      '@app/shared': path.resolve(__dirname, '../shared/src'),
      '@app/llm-client': path.resolve(__dirname, '../llm-client/src'),
    },
  },
});
