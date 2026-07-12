// Side-effect module: load the monorepo-root .env BEFORE any package that
// reads env at import time (e.g. @app/db's client). Must be imported first.
// (ESM evaluates imports in order, so a bare side-effect import guarantees
// this runs before later imports are evaluated.)
import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });
