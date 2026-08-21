import { createOpenAI } from '@ai-sdk/openai';
import { generateText, generateObject, embedMany } from 'ai';
import { z } from 'zod';
import { getEnv, logger } from '@app/shared';

const env = getEnv();
const log = logger.child({ module: 'llm-client' });

const useOpenRouter = env.LLM_TRANSPORT === 'openrouter';

// Dated OpenRouter slugs — bump these when a new V4 GA lands. See README
// "Chat model (DeepSeek V4)" for the lookup table and why they are dated.
const OPENROUTER_CHAT = {
  pro: 'deepseek/deepseek-v4-pro-0813',
  flash: 'deepseek/deepseek-v4-flash-0731',
} as const;

const GATEWAY_CHAT = {
  pro: 'chat-main',
  flash: 'chat-cheap',
} as const;

const DEFAULT_CHAT_MODEL = useOpenRouter
  ? OPENROUTER_CHAT[env.LLM_CHAT_TIER]
  : GATEWAY_CHAT[env.LLM_CHAT_TIER];
const DEFAULT_EMBED_MODEL = useOpenRouter
  ? 'openai/text-embedding-3-small'
  : 'embed';

log.info(
  {
    transport: env.LLM_TRANSPORT,
    tier: env.LLM_CHAT_TIER,
    thinking: env.LLM_THINKING,
    model: DEFAULT_CHAT_MODEL,
  },
  'chat model defaults',
);

const llm = createOpenAI({
  baseURL: useOpenRouter
    ? 'https://openrouter.ai/api/v1'
    : `${env.LLM_GATEWAY_URL}/v1`,
  apiKey: useOpenRouter ? env.OPENROUTER_API_KEY! : env.LLM_GATEWAY_KEY!,
});

type BaseOpts = {
  model?: string;
  system?: string;
  prompt?: string;
  messages?: any[];
  maxTokens?: number;
  temperature?: number;
};

function chatRequest(opts: BaseOpts) {
  const model = opts.model || DEFAULT_CHAT_MODEL;
  const { model: _model, maxTokens, ...rest } = opts;

  return {
    model: llm.chat(model),
    ...rest,
    maxOutputTokens: maxTokens ?? (env.LLM_THINKING ? 8192 : 2048),
    providerOptions: {
      openai: {
        reasoningEffort: env.LLM_THINKING ? ('high' as const) : ('none' as const),
      },
    },
  };
}

export async function complete(opts: BaseOpts) {
  return generateText(chatRequest(opts) as any);
}

export async function extract<T>(schema: z.ZodType<T>, opts: BaseOpts) {
  return generateObject({
    ...chatRequest(opts),
    schema: schema as any,
  } as any);
}

export async function embed(texts: string[]) {
  const { embeddings } = await embedMany({
    model: llm.embedding(DEFAULT_EMBED_MODEL),
    values: texts,
  });

  if (!embeddings || embeddings.length === 0 || !embeddings[0]) {
    throw new Error('No embeddings returned');
  }

  const dim = embeddings[0].length;
  // Assert the returned dimension is 1536 (from text-embedding-3-small)
  if (dim !== 1536) {
    throw new Error(`Embedding dimension mismatch: expected 1536, got ${dim}`);
  }

  return embeddings;
}
