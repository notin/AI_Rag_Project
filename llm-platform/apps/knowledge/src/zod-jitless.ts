// Side-effect module: disable Zod's JIT outside production.
//
// Zod 4 compiles object schemas into a validator built with `new Function`
// ($ZodObjectJIT in zod/v4/core/schemas.js). That function has no source file,
// so a debugger shows it as `anonymous(shape, payload, ctx)` in an unnamed
// script and "do not step into library scripts" cannot filter it — there is no
// path to match against. Interpreted parsing lives in real files instead.
//
// Import order matters: $ZodObjectJIT reads globalConfig.jitless once, when the
// schema is constructed, not when it parses. This must run before any
// z.object() anywhere in the process — hence the bare import high in server.ts.
import { config } from 'zod';

if (process.env.NODE_ENV !== 'production') {
  config({ jitless: true });
}
