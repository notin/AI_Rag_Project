import { createOpenAI } from '@ai-sdk/openai';
import { generateText, generateObject, embedMany } from 'ai';
import { z } from 'zod';
import { getEnv } from '@app/shared';

const env = getEnv();

const useOpenRouter = env.LLM_TRANSPORT === 'openrouter';

// gateway → LiteLLM aliases; openrouter → provider model ids
const DEFAULT_CHAT_MODEL = useOpenRouter
  ? 'deepseek/deepseek-chat'
  : 'chat-main';
const DEFAULT_EMBED_MODEL = useOpenRouter
  ? 'openai/text-embedding-3-small'
  : 'embed';

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

export async function complete(opts: BaseOpts) {
  const model = opts.model || DEFAULT_CHAT_MODEL;
  const { model: _model, ...rest } = opts;

  return generateText({
    model: llm.chat(model),
    ...(rest as any),
  });
}

export async function extract<T>(schema: z.ZodType<T>, opts: BaseOpts) {
  const model = opts.model || DEFAULT_CHAT_MODEL;
  const { model: _model, ...rest } = opts;

  return generateObject({
    model: llm.chat(model),
    schema: schema as any,
    ...(rest as any),
  });
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
