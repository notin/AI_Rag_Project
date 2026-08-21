import { z } from "zod";

const emptyToUndefined = (v: unknown) =>
  v === "" || v == null ? undefined : v;

const boolish = (v: unknown) => {
  if (v === "" || v == null) return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return v;
};

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    // gateway = LiteLLM (default). openrouter = call OpenRouter directly (no Docker).
    LLM_TRANSPORT: z.enum(["gateway", "openrouter"]).default("gateway"),
    // DeepSeek V4 via OpenRouter. See README "Chat model (DeepSeek V4)".
    LLM_CHAT_TIER: z.enum(["pro", "flash"]).default("pro"),
    LLM_THINKING: z.preprocess(boolish, z.boolean().default(true)),
    LLM_GATEWAY_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
    LLM_GATEWAY_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    OPENROUTER_API_KEY: z.preprocess(
      emptyToUndefined,
      z.string().min(1).optional(),
    ),
    // optional until Stage 3 — treat blank .env values as unset
    COHERE_API_KEY: z.preprocess(
      emptyToUndefined,
      z.string().min(1).optional(),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_TRANSPORT === "gateway") {
      if (!env.LLM_GATEWAY_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["LLM_GATEWAY_URL"],
          message: "Required when LLM_TRANSPORT=gateway",
        });
      }
      if (!env.LLM_GATEWAY_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["LLM_GATEWAY_KEY"],
          message: "Required when LLM_TRANSPORT=gateway",
        });
      }
    }
    if (env.LLM_TRANSPORT === "openrouter" && !env.OPENROUTER_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPENROUTER_API_KEY"],
        message: "Required when LLM_TRANSPORT=openrouter",
      });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Parse and cache environment once. Throws a readable, aggregated error
 * listing every missing/invalid var instead of failing one at a time.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
