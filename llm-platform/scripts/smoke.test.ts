import 'dotenv/config';
import { complete, embed } from '@app/llm-client';

describe('Gateway Tests', () => {
  it(
    'should get a completion from complete()',
    async () => {
      const res = await complete({
        prompt:
          'Hello! Just testing the connection. Please reply with a single word "Ready".',
      });
      console.log(`Response: ${res.text}`);
      expect(res).toBeDefined();
      expect(typeof res.text).toBe('string');
      expect(res.text.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it(
    'should get embeddings from embed()',
    async () => {
      const vectors = await embed(['This is a test document.']);
      console.log(`Embedded vector length: ${vectors[0].length}`);
      expect(vectors).toBeDefined();
      expect(vectors.length).toBe(1);
      expect(vectors[0].length).toBeGreaterThan(0);
    },
    30_000,
  );
});
