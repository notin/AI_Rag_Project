import { hiddenNotFound } from "@lab/errors";
import { decodeCursor, parseLimit } from "./cursor.js";
import { requireOwnedAsset } from "./assets.js";
import type { Ports } from "./ports.js";
import type { HarvestCreateInput, Job, Page, Harvest } from "./types.js";
import { parseHarvestCreate, requireIdempotencyKey } from "./validate.js";

/**
 * Accept a harvest create. Writes a pending job and publishes an event.
 * Does not write a harvest row — that is the worker's job (Stage 4).
 */
export async function requestHarvest(
  ports: Ports,
  callerId: string,
  assetId: string,
  idempotencyKey: string | undefined,
  input: unknown,
): Promise<Job> {
  requireIdempotencyKey(idempotencyKey);
  const body: HarvestCreateInput = parseHarvestCreate(input ?? {});
  await requireOwnedAsset(ports, callerId, assetId);

  const now = ports.clock.now();
  const job: Job = {
    jobId: ports.ids.uuid(),
    type: "harvest",
    status: "pending",
    assetId,
    ownerId: callerId,
    createdAt: now,
    updatedAt: now,
  };
  await ports.jobs.put(job);
  await ports.events.publishHarvestRequested({
    jobId: job.jobId,
    assetId,
    ownerId: callerId,
    profile: body.profile,
  });
  return job;
}

export async function getJob(ports: Ports, callerId: string, jobId: string): Promise<Job> {
  const job = await ports.jobs.get(jobId);
  if (!job || job.ownerId !== callerId) {
    throw hiddenNotFound("job", jobId);
  }
  return job;
}

export async function listHarvests(
  ports: Ports,
  callerId: string,
  assetId: string,
  limit: number | undefined,
  cursor: string | undefined,
): Promise<Page<Harvest>> {
  await requireOwnedAsset(ports, callerId, assetId);
  if (cursor) {
    decodeCursor(cursor);
  }
  return ports.harvests.listByAsset(assetId, parseLimit(limit), cursor);
}
