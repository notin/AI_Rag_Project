// Barrel exports for @app/db
export { db, closeDb } from './client.js';
export {
  documents,
  chunks,
  EMBEDDING_DIMENSIONS,
  type Document,
  type NewDocument,
  type Chunk,
  type NewChunk,
} from './schema.js';
export { chunkText, type ChunkOptions, type ChunkResult } from './chunk.js';
export { ingestFile, ingestDirectory, type IngestResult } from './ingest.js';
export { semanticSearch, type SearchResult } from './search.js';
