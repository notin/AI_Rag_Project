// ─── Structure-aware text chunker ───────────────────────────────────────────
//
// Splits markdown/plain text into chunks suitable for embedding.
// Pure function — no I/O, fully unit-testable.
//
// Strategy:
// 1. Split on structural boundaries (headings, blank lines, code fences).
// 2. Merge small blocks until we hit the target size.
// 3. Add overlap between consecutive chunks so a thought split
//    across a boundary is still findable.

export interface ChunkOptions {
  /** Target chunk size in characters. Default ~2500 (~625 tokens). */
  targetSize?: number;
  /** Maximum chunk size in characters. Default ~3200 (~800 tokens). */
  maxSize?: number;
  /** Overlap fraction (0–1). Default 0.15 (15%). */
  overlapFraction?: number;
}

export interface ChunkResult {
  /** Zero-based ordinal within the document. */
  ordinal: number;
  /** The chunk text content. */
  text: string;
}

const DEFAULTS: Required<ChunkOptions> = {
  targetSize: 2500,
  maxSize: 3200,
  overlapFraction: 0.15,
};

/**
 * Split text into chunks respecting markdown structure.
 *
 * The splitter:
 * - Never breaks inside a code fence (``` ... ```)
 * - Prefers splitting at heading boundaries (# ## ### etc.)
 * - Falls back to blank-line boundaries
 * - Hard-splits at maxSize if a single block is too long
 * - Adds ~15% overlap between consecutive chunks
 */
export function chunkText(
  text: string,
  opts?: ChunkOptions,
): ChunkResult[] {
  const { targetSize, maxSize, overlapFraction } = { ...DEFAULTS, ...opts };

  if (!text || text.trim().length === 0) return [];

  // ── Step 1: Split into structural blocks ──────────────────────────────
  const blocks = splitIntoBlocks(text);

  // ── Step 2: Merge blocks into target-sized chunks ─────────────────────
  const rawChunks = mergeBlocks(blocks, targetSize, maxSize);

  // ── Step 3: Add overlap ───────────────────────────────────────────────
  const overlappedChunks = addOverlap(rawChunks, overlapFraction, maxSize);

  return overlappedChunks.map((c, i) => ({
    ordinal: i,
    text: c.trim(),
  }));
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Split text into structural blocks: headings, paragraphs, code fences.
 * Code fences are kept as single atomic blocks (never split mid-fence).
 */
function splitIntoBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track code fence state
    if (trimmed.startsWith('```')) {
      if (inCodeFence) {
        // Closing fence — finish the code block
        current.push(line);
        blocks.push(current.join('\n'));
        current = [];
        inCodeFence = false;
        continue;
      } else {
        // Opening fence — flush any current block first
        if (current.length > 0) {
          blocks.push(current.join('\n'));
          current = [];
        }
        current.push(line);
        inCodeFence = true;
        continue;
      }
    }

    if (inCodeFence) {
      current.push(line);
      continue;
    }

    // Heading = new block boundary
    if (trimmed.match(/^#{1,6}\s/)) {
      if (current.length > 0) {
        blocks.push(current.join('\n'));
        current = [];
      }
      current.push(line);
      continue;
    }

    // Blank line = paragraph boundary
    if (trimmed === '') {
      if (current.length > 0) {
        blocks.push(current.join('\n'));
        current = [];
      }
      continue;
    }

    current.push(line);
  }

  // Flush remaining
  if (current.length > 0) {
    blocks.push(current.join('\n'));
  }

  return blocks.filter((b) => b.trim().length > 0);
}

/**
 * Merge small blocks until we reach targetSize, hard-split if over maxSize.
 */
function mergeBlocks(
  blocks: string[],
  targetSize: number,
  maxSize: number,
): string[] {
  const merged: string[] = [];
  let current = '';

  for (const block of blocks) {
    // If adding this block would exceed target and we have content, flush
    if (
      current.length > 0 &&
      current.length + block.length + 1 > targetSize
    ) {
      merged.push(current);
      current = '';
    }

    // If single block exceeds maxSize, hard-split it
    if (block.length > maxSize) {
      if (current.length > 0) {
        merged.push(current);
        current = '';
      }
      const hardChunks = hardSplit(block, maxSize);
      merged.push(...hardChunks);
      continue;
    }

    current = current.length > 0 ? current + '\n\n' + block : block;
  }

  if (current.length > 0) {
    merged.push(current);
  }

  return merged;
}

/**
 * Hard-split a single oversized block at sentence/word boundaries.
 */
function hardSplit(text: string, maxSize: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxSize) {
    // Try to split at a sentence boundary
    let splitIdx = remaining.lastIndexOf('. ', maxSize);
    if (splitIdx < maxSize * 0.5) {
      // No good sentence boundary — split at a space
      splitIdx = remaining.lastIndexOf(' ', maxSize);
    }
    if (splitIdx < maxSize * 0.3) {
      // Desperate: just split at maxSize
      splitIdx = maxSize;
    }

    chunks.push(remaining.slice(0, splitIdx + 1));
    remaining = remaining.slice(splitIdx + 1).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Add overlap between consecutive chunks.
 * Takes the last N characters of the previous chunk and prepends to the next.
 */
function addOverlap(
  chunks: string[],
  overlapFraction: number,
  maxSize: number,
): string[] {
  if (chunks.length <= 1) return chunks;

  const result: string[] = [chunks[0]!];

  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!;
    const curr = chunks[i]!;

    const overlapSize = Math.floor(prev.length * overlapFraction);
    if (overlapSize <= 0) {
      result.push(curr);
      continue;
    }

    // Find a clean word boundary for the overlap start
    const overlapStart = prev.length - overlapSize;
    let cleanStart = prev.indexOf(' ', overlapStart);
    if (cleanStart === -1 || cleanStart >= prev.length) {
      cleanStart = overlapStart;
    }

    const overlap = prev.slice(cleanStart).trim();
    const withOverlap = overlap + '\n\n' + curr;

    // Don't exceed maxSize with overlap
    if (withOverlap.length > maxSize) {
      result.push(curr);
    } else {
      result.push(withOverlap);
    }
  }

  return result;
}
