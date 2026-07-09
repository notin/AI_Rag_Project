import { describe, it, expect } from 'vitest';
import { chunkText } from '../chunk.js';

describe('chunkText', () => {
  it('returns empty array for empty/whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
    expect(chunkText('\n\n')).toEqual([]);
  });

  it('returns a single chunk for short text', () => {
    const text = '# Hello\n\nThis is a short paragraph.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.ordinal).toBe(0);
    expect(chunks[0]!.text).toContain('Hello');
    expect(chunks[0]!.text).toContain('short paragraph');
  });

  it('splits on heading boundaries', () => {
    const text = [
      '# Section One',
      '',
      'Content for section one. '.repeat(80), // ~2000 chars
      '',
      '# Section Two',
      '',
      'Content for section two. '.repeat(80), // ~2000 chars
    ].join('\n');

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // First chunk should contain section one
    expect(chunks[0]!.text).toContain('Section One');
    // Last chunk should contain section two
    expect(chunks[chunks.length - 1]!.text).toContain('Section Two');
  });

  it('keeps code fences intact (never splits mid-fence)', () => {
    const text = [
      '# Code Example',
      '',
      '```python',
      'def hello():',
      '    print("Hello, world!")',
      '    return True',
      '```',
      '',
      'Some text after the code block.',
    ].join('\n');

    const chunks = chunkText(text);

    // Find the chunk containing the code fence
    const codeChunk = chunks.find((c) => c.text.includes('```python'));
    expect(codeChunk).toBeDefined();

    // The code fence should be complete — both opening and closing ```
    const fenceCount = (codeChunk!.text.match(/```/g) || []).length;
    expect(fenceCount).toBe(2); // opening + closing
    expect(codeChunk!.text).toContain('def hello()');
    expect(codeChunk!.text).toContain('return True');
  });

  it('respects blank line paragraph boundaries', () => {
    const text = [
      'Paragraph one content. '.repeat(60), // ~1380 chars
      '',
      'Paragraph two content. '.repeat(60), // ~1380 chars
      '',
      'Paragraph three content. '.repeat(60), // ~1440 chars
    ].join('\n');

    const chunks = chunkText(text);
    // With ~4200 chars total and 2500 target, should get at least 2 chunks
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('assigns sequential ordinals', () => {
    const text = [
      '# Part 1',
      'Content one. '.repeat(100),
      '',
      '# Part 2',
      'Content two. '.repeat(100),
      '',
      '# Part 3',
      'Content three. '.repeat(100),
    ].join('\n');

    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.ordinal).toBe(i);
    }
  });

  it('generates overlap between consecutive chunks', () => {
    // Create a long text without headings to force overlap
    const sentences = [
      'The quick brown fox jumps over the lazy dog.',
      'Pack my box with five dozen liquor jugs.',
      'How vexingly quick daft zebras jump.',
      'Sphinx of black quartz judge my vow.',
      'Two driven jocks help fax my big quiz.',
    ];

    // Build text long enough to produce multiple chunks
    // Use plain paragraphs separated by blank lines (no headings)
    const paragraphs: string[] = [];
    for (let i = 0; i < 20; i++) {
      const sentence = sentences[i % sentences.length]!;
      paragraphs.push(sentence.repeat(15));
    }
    const text = paragraphs.join('\n\n');

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // At least one pair of consecutive chunks should share content
    let overlapFound = false;
    for (let i = 1; i < chunks.length; i++) {
      const prevChunk = chunks[i - 1]!;
      const currChunk = chunks[i]!;

      // Extract the last 10 words of previous chunk
      const prevWords = prevChunk.text.trim().split(/\s+/);
      const lastWords = prevWords.slice(-10).join(' ');

      // Check if they appear in the current chunk
      if (currChunk.text.includes(lastWords)) {
        overlapFound = true;
        break;
      }
    }

    expect(overlapFound).toBe(true);
  });

  it('handles custom chunk size options', () => {
    const text = 'Word. '.repeat(500); // ~3000 chars

    const smallChunks = chunkText(text, { targetSize: 500, maxSize: 800 });
    const largeChunks = chunkText(text, { targetSize: 2500, maxSize: 3200 });

    expect(smallChunks.length).toBeGreaterThan(largeChunks.length);
  });

  it('hard-splits oversized blocks that exceed maxSize', () => {
    // A single block with no natural boundaries
    const text = 'A'.repeat(5000); // way over maxSize

    const chunks = chunkText(text, { maxSize: 1000 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);

    // No chunk should exceed maxSize (plus a small margin for overlap)
    for (const chunk of chunks) {
      // Allow 20% margin for overlap additions
      expect(chunk.text.length).toBeLessThanOrEqual(1200);
    }
  });
});
