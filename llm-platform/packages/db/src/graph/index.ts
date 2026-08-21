// Barrel exports for the graph layer.

export {
  ENTITY_TYPES,
  RELATIONS,
  WALK_RELATIONS,
  INVERSE_LABEL,
  RELATION_ENDPOINTS,
  entityTypeSchema,
  relationSchema,
  isValidEndpointPair,
  isSeedOwned,
  normalizeName,
  entityKey,
  type EntityType,
  type Relation,
} from './vocab.js';

export {
  entities,
  entityAliases,
  edges,
  edgeChunks,
  chunkEntities,
  chunkExtractions,
  type Entity,
  type NewEntity,
  type Edge,
  type NewEdge,
  type EdgeOrigin,
} from './schema.js';

export { TYPE_CHART, POKEMON_TYPES, type PokemonTypeName } from './type-chart.js';
export { seedTypeChart, type SeedResult } from './seed.js';

export {
  extractFromChunk,
  PROMPT_VERSION,
  type ChunkExtraction,
  type ExtractedEntity,
  type ExtractedRelation,
} from './extract.js';

export {
  resolveEntities,
  type EntityCandidate,
  type ResolutionResult,
  type ResolutionStats,
} from './resolve.js';

export {
  graphExpand,
  graphSearch,
  type ExpandOptions,
  type GraphExpansion,
  type ExpandedChunk,
  type ReachedEntity,
} from './traverse.js';

export {
  graphFacts,
  renderFact,
  renderFactBlock,
  inverseLabel,
  type GraphFact,
  type FactsOptions,
} from './facts.js';

export {
  typeMatchups,
  composeMatchup,
  renderMatchup,
  type Matchup,
  type MatchupBucket,
  type Effect,
} from './matchup.js';

export {
  buildGraph,
  collectOrphans,
  type BuildGraphOptions,
  type BuildGraphResult,
  type GcResult,
} from './build.js';

export {
  graphRetrieve,
  type GraphRetrieveResult,
  type GraphRetrieveOptions,
  type GraphChunk,
} from './retrieve.js';

export { graphStats, type GraphStats } from './stats.js';
