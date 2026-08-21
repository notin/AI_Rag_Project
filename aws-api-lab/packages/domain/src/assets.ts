import { hiddenNotFound, PreconditionFailedError, ValidationError } from "@lab/errors";
import { decodeCursor, parseLimit } from "./cursor.js";
import { versionFromIfMatch } from "./etag.js";
import type { Ports } from "./ports.js";
import type { Asset, AssetCreateInput, AssetPatchInput, AssetReplaceInput, Page } from "./types.js";
import { parseAssetCreate, parseAssetPatch, parseAssetReplace, requireIdempotencyKey } from "./validate.js";

function ownedOrHidden(asset: Asset | undefined, callerId: string, assetId: string): Asset {
  if (!asset || asset.ownerId !== callerId) {
    throw hiddenNotFound("asset", assetId);
  }
  return asset;
}

export async function createAsset(
  ports: Ports,
  callerId: string,
  idempotencyKey: string | undefined,
  input: unknown,
): Promise<Asset> {
  const key = requireIdempotencyKey(idempotencyKey);
  const body: AssetCreateInput = parseAssetCreate(input);
  const replay = await ports.idempotency.get(callerId, key);
  if (replay) {
    return replay.asset;
  }

  const now = ports.clock.now();
  const asset: Asset = {
    assetId: ports.ids.uuid(),
    ownerId: callerId,
    name: body.name,
    description: body.description,
    status: "active",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await ports.assets.putNew(asset);
  await ports.idempotency.put({ ownerId: callerId, key, asset });
  return asset;
}

export async function getAsset(ports: Ports, callerId: string, assetId: string): Promise<Asset> {
  return ownedOrHidden(await ports.assets.get(assetId), callerId, assetId);
}

export async function listAssets(
  ports: Ports,
  callerId: string,
  limit: number | undefined,
  cursor: string | undefined,
): Promise<Page<Asset>> {
  if (cursor) {
    decodeCursor(cursor);
  }
  return ports.assets.listByOwner(callerId, parseLimit(limit), cursor);
}

export async function replaceAsset(
  ports: Ports,
  callerId: string,
  assetId: string,
  ifMatch: string | undefined,
  input: unknown,
): Promise<Asset> {
  const expected = versionFromIfMatch(ifMatch);
  const body: AssetReplaceInput = parseAssetReplace(input);
  const current = ownedOrHidden(await ports.assets.get(assetId), callerId, assetId);
  if (current.version !== expected) {
    throw new PreconditionFailedError("If-Match does not match the current ETag");
  }
  const next: Asset = {
    ...current,
    name: body.name,
    description: body.description,
    status: body.status,
    version: current.version + 1,
    updatedAt: ports.clock.now(),
  };
  await ports.assets.putIfVersion(next, expected);
  return next;
}

export async function patchAsset(
  ports: Ports,
  callerId: string,
  assetId: string,
  ifMatch: string | undefined,
  input: unknown,
): Promise<Asset> {
  const expected = versionFromIfMatch(ifMatch);
  const body: AssetPatchInput = parseAssetPatch(input);
  if (body.name === undefined && body.description === undefined && body.status === undefined) {
    throw new ValidationError("patch document must include at least one field");
  }
  const current = ownedOrHidden(await ports.assets.get(assetId), callerId, assetId);
  if (current.version !== expected) {
    throw new PreconditionFailedError("If-Match does not match the current ETag");
  }
  const next: Asset = {
    ...current,
    name: body.name ?? current.name,
    description: body.description ?? current.description,
    status: body.status ?? current.status,
    version: current.version + 1,
    updatedAt: ports.clock.now(),
  };
  await ports.assets.putIfVersion(next, expected);
  return next;
}

export async function deleteAsset(
  ports: Ports,
  callerId: string,
  assetId: string,
  ifMatch: string | undefined,
): Promise<void> {
  const expected = versionFromIfMatch(ifMatch);
  const current = ownedOrHidden(await ports.assets.get(assetId), callerId, assetId);
  if (current.version !== expected) {
    throw new PreconditionFailedError("If-Match does not match the current ETag");
  }
  await ports.assets.deleteIfVersion(assetId, expected);
}

export async function requireOwnedAsset(ports: Ports, callerId: string, assetId: string): Promise<Asset> {
  return ownedOrHidden(await ports.assets.get(assetId), callerId, assetId);
}
