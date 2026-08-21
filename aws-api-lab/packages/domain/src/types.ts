export type AssetStatus = "active" | "archived";
export type JobStatus = "pending" | "processing" | "succeeded" | "failed";
export type HarvestStatus = "pending" | "processing" | "succeeded" | "failed";

export type Asset = {
  assetId: string;
  ownerId: string;
  name: string;
  description?: string;
  status: AssetStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type Harvest = {
  harvestId: string;
  assetId: string;
  status: HarvestStatus;
  createdAt: string;
  updatedAt: string;
};

export type Job = {
  jobId: string;
  type: "harvest";
  status: JobStatus;
  assetId: string;
  ownerId: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
};

export type AssetCreateInput = {
  name: string;
  description?: string;
};

export type AssetReplaceInput = {
  name: string;
  description?: string;
  status: AssetStatus;
};

export type AssetPatchInput = {
  name?: string;
  description?: string;
  status?: AssetStatus;
};

export type HarvestCreateInput = {
  profile?: string;
};

export type HarvestRequested = {
  jobId: string;
  assetId: string;
  ownerId: string;
  profile?: string;
};

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
};
