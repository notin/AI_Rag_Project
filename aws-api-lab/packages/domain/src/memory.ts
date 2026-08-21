import { ConflictError, PreconditionFailedError, ValidationError } from "@lab/errors";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type {
  AssetStore,
  HarvestEvents,
  HarvestStore,
  IdempotencyRecord,
  IdempotencyStore,
  JobStore,
  Ports,
} from "./ports.js";
import type { Asset, Harvest, HarvestRequested, Job, Page } from "./types.js";

function pageAfter<T extends { id: string }>(
  sorted: T[],
  limit: number,
  cursor: string | undefined,
  cursorField: string,
): Page<T> {
  let start = 0;
  if (cursor) {
    const key = decodeCursor(cursor)[cursorField];
    if (!key) {
      throw new ValidationError("cursor is not a valid nextCursor", "BAD_CURSOR");
    }
    const idx = sorted.findIndex((row) => row.id === key);
    start = idx === -1 ? sorted.findIndex((row) => row.id > key) : idx + 1;
    if (start < 0) {
      return { items: [], nextCursor: null };
    }
  }
  const items = sorted.slice(start, start + limit);
  const last = items[items.length - 1];
  const nextCursor =
    last && start + items.length < sorted.length ? encodeCursor({ [cursorField]: last.id }) : null;
  return { items, nextCursor };
}

export class MemoryAssetStore implements AssetStore {
  readonly rows = new Map<string, Asset>();

  async get(assetId: string): Promise<Asset | undefined> {
    return this.rows.get(assetId);
  }

  async putNew(asset: Asset): Promise<void> {
    if (this.rows.has(asset.assetId)) {
      throw new ConflictError("asset already exists");
    }
    this.rows.set(asset.assetId, asset);
  }

  async putIfVersion(asset: Asset, expectedVersion: number): Promise<void> {
    const current = this.rows.get(asset.assetId);
    if (!current || current.version !== expectedVersion) {
      throw new PreconditionFailedError("If-Match does not match the current ETag");
    }
    this.rows.set(asset.assetId, asset);
  }

  async deleteIfVersion(assetId: string, expectedVersion: number): Promise<void> {
    const current = this.rows.get(assetId);
    if (!current || current.version !== expectedVersion) {
      throw new PreconditionFailedError("If-Match does not match the current ETag");
    }
    this.rows.delete(assetId);
  }

  async listByOwner(ownerId: string, limit: number, cursor: string | undefined): Promise<Page<Asset>> {
    const sorted = [...this.rows.values()]
      .filter((row) => row.ownerId === ownerId)
      .sort((a, b) => a.assetId.localeCompare(b.assetId))
      .map((row) => ({ id: row.assetId, row }));
    const page = pageAfter(sorted, limit, cursor, "assetId");
    return { items: page.items.map((item) => item.row), nextCursor: page.nextCursor };
  }
}

export class MemoryHarvestStore implements HarvestStore {
  readonly rows: Harvest[] = [];
  putCount = 0;

  async get(assetId: string, harvestId: string): Promise<Harvest | undefined> {
    return this.rows.find((row) => row.assetId === assetId && row.harvestId === harvestId);
  }

  async put(harvest: Harvest): Promise<void> {
    this.putCount += 1;
    this.rows.push(harvest);
  }

  async listByAsset(assetId: string, limit: number, cursor: string | undefined): Promise<Page<Harvest>> {
    const sorted = this.rows
      .filter((row) => row.assetId === assetId)
      .sort((a, b) => a.harvestId.localeCompare(b.harvestId))
      .map((row) => ({ id: row.harvestId, row }));
    const page = pageAfter(sorted, limit, cursor, "harvestId");
    return { items: page.items.map((item) => item.row), nextCursor: page.nextCursor };
  }
}

export class MemoryJobStore implements JobStore {
  readonly rows = new Map<string, Job>();

  async get(jobId: string): Promise<Job | undefined> {
    return this.rows.get(jobId);
  }

  async put(job: Job): Promise<void> {
    this.rows.set(job.jobId, job);
  }
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly rows = new Map<string, IdempotencyRecord>();

  async get(ownerId: string, key: string): Promise<IdempotencyRecord | undefined> {
    return this.rows.get(`${ownerId}#${key}`);
  }

  async put(record: IdempotencyRecord): Promise<void> {
    const id = `${record.ownerId}#${record.key}`;
    const existing = this.rows.get(id);
    if (existing && existing.asset.assetId !== record.asset.assetId) {
      throw new ConflictError("idempotency key already used");
    }
    this.rows.set(id, record);
  }
}

export class MemoryHarvestEvents implements HarvestEvents {
  readonly published: HarvestRequested[] = [];

  async publishHarvestRequested(detail: HarvestRequested): Promise<void> {
    this.published.push(detail);
  }
}

export function createMemoryPorts(overrides?: Partial<Ports>): Ports {
  const assets = new MemoryAssetStore();
  const harvests = new MemoryHarvestStore();
  const jobs = new MemoryJobStore();
  const idempotency = new MemoryIdempotencyStore();
  const events = new MemoryHarvestEvents();
  return {
    assets,
    harvests,
    jobs,
    idempotency,
    events,
    clock: { now: () => new Date().toISOString() },
    ids: { uuid: () => crypto.randomUUID() },
    ...overrides,
  };
}
