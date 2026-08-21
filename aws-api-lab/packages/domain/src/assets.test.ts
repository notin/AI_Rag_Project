import { describe, expect, it } from "vitest";
import { PreconditionFailedError, toProblem } from "@lab/errors";
import {
  createAsset,
  createMemoryPorts,
  deleteAsset,
  etagFromVersion,
  getAsset,
  listAssets,
  replaceAsset,
} from "./index.js";
import { MemoryAssetStore, MemoryHarvestEvents, MemoryHarvestStore } from "./memory.js";
import { getJob, requestHarvest } from "./harvests.js";

const caller = "user-1";
const key = "idempotency-key-1";

function portsWithIds(ids: string[]) {
  let i = 0;
  const ports = createMemoryPorts({
    ids: {
      uuid: () => {
        const id = ids[i];
        if (!id) {
          throw new Error("ran out of test ids");
        }
        i += 1;
        return id;
      },
    },
  });
  return ports;
}

describe("asset writes and ETags", () => {
  it("create → get ETag → stale If-Match 412 → matching If-Match bumps version", async () => {
    const ports = createMemoryPorts();
    const created = await createAsset(ports, caller, key, { name: "Clip A" });
    expect(created.version).toBe(1);
    expect(etagFromVersion(created.version)).toBe('W/"1"');

    const got = await getAsset(ports, caller, created.assetId);
    expect(got.version).toBe(1);

    await expect(
      replaceAsset(ports, caller, created.assetId, 'W/"0"', { name: "Clip A", status: "active" }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);

    const stale = await replaceAsset(ports, caller, created.assetId, 'W/"0"', {
      name: "Clip A",
      status: "active",
    }).catch((err: unknown) => toProblem(err, { requestId: "r1" }));
    expect(stale).toMatchObject({ status: 412, code: "PRECONDITION_FAILED" });

    const updated = await replaceAsset(ports, caller, created.assetId, 'W/"1"', {
      name: "Clip A2",
      status: "archived",
    });
    expect(updated.version).toBe(2);
    expect(updated.name).toBe("Clip A2");
    expect(etagFromVersion(updated.version)).toBe('W/"2"');
  });

  it("hides another caller's asset as 404", async () => {
    const ports = createMemoryPorts();
    const created = await createAsset(ports, caller, key, { name: "Secret" });
    await expect(getAsset(ports, "user-2", created.assetId)).rejects.toMatchObject({
      code: "ASSET_NOT_FOUND",
      status: 404,
    });
  });

  it("replays POST with the same Idempotency-Key instead of creating a second row", async () => {
    const ports = createMemoryPorts();
    const first = await createAsset(ports, caller, key, { name: "Once" });
    const second = await createAsset(ports, caller, key, { name: "Once" });
    expect(second.assetId).toBe(first.assetId);
    expect([...(ports.assets as MemoryAssetStore).rows.keys()]).toHaveLength(1);
  });

  it("delete requires a matching ETag", async () => {
    const ports = createMemoryPorts();
    const created = await createAsset(ports, caller, key, { name: "Gone" });
    await expect(deleteAsset(ports, caller, created.assetId, 'W/"9"')).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    await deleteAsset(ports, caller, created.assetId, 'W/"1"');
    await expect(getAsset(ports, caller, created.assetId)).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
  });
});

describe("cursor pagination vs offset", () => {
  it("round-trips nextCursor across two pages", async () => {
    const ports = portsWithIds(["a1", "a2", "a3", "a4"]);
    for (const name of ["one", "two", "three", "four"]) {
      await createAsset(ports, caller, `idempotency-${name}xx`, { name });
    }
    const page1 = await listAssets(ports, caller, 2, undefined);
    expect(page1.items.map((a) => a.assetId)).toEqual(["a1", "a2"]);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await listAssets(ports, caller, 2, page1.nextCursor ?? undefined);
    expect(page2.items.map((a) => a.assetId)).toEqual(["a3", "a4"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("inserting on page 1 does not duplicate-or-skip the way offset would", async () => {
    const ports = portsWithIds(["b", "c", "d", "e", "a"]);
    for (const name of ["b", "c", "d", "e"]) {
      await createAsset(ports, caller, `idempotency-${name}xxxx`, { name });
    }

    const page1 = await listAssets(ports, caller, 2, undefined);
    expect(page1.items.map((row) => row.assetId)).toEqual(["b", "c"]);

    // Insert a new first page item (sorts before b). Offset pagination would
    // shift every later row: skip(2) on [a,b,c,d,e] returns [c,d] — duplicate c,
    // drop e. Keyset (cursor = last key of page 1) still means "after c".
    await createAsset(ports, caller, "idempotency-a-insert", { name: "a" });

    const page2 = await listAssets(ports, caller, 2, page1.nextCursor ?? undefined);
    expect(page2.items.map((row) => row.assetId)).toEqual(["d", "e"]);

    const offsetSorted = ["a", "b", "c", "d", "e"];
    const offsetPage2 = offsetSorted.slice(2, 4);
    expect(offsetPage2).toEqual(["c", "d"]);
    expect(page2.items.map((row) => row.assetId)).not.toEqual(offsetPage2);
  });
});

describe("requestHarvest", () => {
  it("returns a job and does not write a harvest row", async () => {
    const harvests = new MemoryHarvestStore();
    const events = new MemoryHarvestEvents();
    const ports = createMemoryPorts({ harvests, events });
    const asset = await createAsset(ports, caller, key, { name: "Clip" });

    const job = await requestHarvest(ports, caller, asset.assetId, "idempotency-harvest-1", {});
    expect(job.status).toBe("pending");
    expect(job.assetId).toBe(asset.assetId);
    expect(harvests.putCount).toBe(0);
    expect(harvests.rows).toHaveLength(0);
    expect(events.published).toHaveLength(1);
    expect(events.published[0]?.jobId).toBe(job.jobId);

    const loaded = await getJob(ports, caller, job.jobId);
    expect(loaded.jobId).toBe(job.jobId);
  });
});
