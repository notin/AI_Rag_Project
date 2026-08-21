import type { Asset, Harvest, HarvestRequested, Job, Page } from "./types.js";

export type AssetStore = {
  get(assetId: string): Promise<Asset | undefined>;
  putNew(asset: Asset): Promise<void>;
  putIfVersion(asset: Asset, expectedVersion: number): Promise<void>;
  deleteIfVersion(assetId: string, expectedVersion: number): Promise<void>;
  listByOwner(ownerId: string, limit: number, cursor: string | undefined): Promise<Page<Asset>>;
};

export type HarvestStore = {
  get(assetId: string, harvestId: string): Promise<Harvest | undefined>;
  put(harvest: Harvest): Promise<void>;
  listByAsset(assetId: string, limit: number, cursor: string | undefined): Promise<Page<Harvest>>;
};

export type JobStore = {
  get(jobId: string): Promise<Job | undefined>;
  put(job: Job): Promise<void>;
};

export type IdempotencyRecord = {
  ownerId: string;
  key: string;
  asset: Asset;
};

export type IdempotencyStore = {
  get(ownerId: string, key: string): Promise<IdempotencyRecord | undefined>;
  put(record: IdempotencyRecord): Promise<void>;
};

export type HarvestEvents = {
  publishHarvestRequested(detail: HarvestRequested): Promise<void>;
};

export type Clock = {
  now(): string;
};

export type Ids = {
  uuid(): string;
};

export type Ports = {
  assets: AssetStore;
  harvests: HarvestStore;
  jobs: JobStore;
  idempotency: IdempotencyStore;
  events: HarvestEvents;
  clock: Clock;
  ids: Ids;
};
