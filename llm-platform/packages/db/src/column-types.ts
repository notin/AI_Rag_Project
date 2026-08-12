// ─── Custom Postgres column types ───────────────────────────────────────────
//
// Drizzle has built-in vector support but we define it explicitly to keep full
// control over the dimension and operator class. Shared by the chunk schema and
// the graph schema, so both agree on the representation.

import { customType } from 'drizzle-orm/pg-core';

export const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: unknown): number[] {
    // postgres.js returns vector as a string like "[0.1,0.2,...]"
    if (typeof value === 'string') {
      return value
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .map(Number);
    }
    return value as number[];
  },
});

/**
 * Postgres full-text search vector. Only ever written by a generated column,
 * so the driver mapping is read-only in practice.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});
