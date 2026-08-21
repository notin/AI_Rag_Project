import { z } from "zod";
import { ValidationError } from "@lab/errors";
import type { AssetCreateInput, AssetPatchInput, AssetReplaceInput, HarvestCreateInput } from "./types.js";

const name = z.string().min(1).max(128);
const description = z.string().max(2048);
const status = z.enum(["active", "archived"]);

const assetCreate = z
  .object({
    name,
    description: description.optional(),
  })
  .strict();

const assetReplace = z
  .object({
    name,
    description: description.optional(),
    status,
  })
  .strict();

const assetPatch = z
  .object({
    name: name.optional(),
    description: description.optional(),
    status: status.optional(),
  })
  .strict();

const harvestCreate = z
  .object({
    profile: z.string().max(64).optional(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, input: unknown, detail: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(detail);
  }
  return result.data;
}

export function parseAssetCreate(input: unknown): AssetCreateInput {
  return parse(assetCreate, input, "asset create payload is invalid");
}

export function parseAssetReplace(input: unknown): AssetReplaceInput {
  return parse(assetReplace, input, "asset replace payload is invalid");
}

export function parseAssetPatch(input: unknown): AssetPatchInput {
  return parse(assetPatch, input, "asset patch payload is invalid");
}

export function parseHarvestCreate(input: unknown): HarvestCreateInput {
  return parse(harvestCreate, input, "harvest create payload is invalid");
}

export function requireIdempotencyKey(key: string | undefined): string {
  if (!key || key.trim().length < 8 || key.trim().length > 256) {
    throw new ValidationError("Idempotency-Key is required (8-256 characters)", "BAD_REQUEST");
  }
  return key.trim();
}
