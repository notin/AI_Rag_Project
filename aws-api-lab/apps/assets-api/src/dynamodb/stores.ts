import { GetCommand, PutCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { decodeCursor, encodeCursor } from "@lab/domain";
import type { Asset, AssetStore, Harvest, HarvestStore, IdempotencyRecord, IdempotencyStore, Job, JobStore, Page } from "@lab/domain";
import { conflictOr, preconditionOr } from "./errors.js";
import { ASSETS_OWNER_INDEX, type TableNames } from "./tables.js";

export class DynamoAssetStore implements AssetStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async get(assetId: string): Promise<Asset | undefined> {
    const result = await this.doc.send(new GetCommand({ TableName: this.table, Key: { assetId } }));
    return result.Item as Asset | undefined;
  }

  async putNew(asset: Asset): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: asset,
          ConditionExpression: "attribute_not_exists(assetId)",
        }),
      );
    } catch (err) {
      conflictOr(err);
    }
  }

  async putIfVersion(asset: Asset, expectedVersion: number): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: asset,
          ConditionExpression: "version = :expected",
          ExpressionAttributeValues: { ":expected": expectedVersion },
        }),
      );
    } catch (err) {
      preconditionOr(err);
    }
  }

  async deleteIfVersion(assetId: string, expectedVersion: number): Promise<void> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { assetId },
          ConditionExpression: "version = :expected",
          ExpressionAttributeValues: { ":expected": expectedVersion },
        }),
      );
    } catch (err) {
      preconditionOr(err);
    }
  }

  async listByOwner(ownerId: string, limit: number, cursor: string | undefined): Promise<Page<Asset>> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: ASSETS_OWNER_INDEX,
        KeyConditionExpression: "ownerId = :ownerId",
        ExpressionAttributeValues: { ":ownerId": ownerId },
        Limit: limit,
        ExclusiveStartKey: cursor ? decodeCursor(cursor) : undefined,
        ScanIndexForward: true,
      }),
    );
    const last = result.LastEvaluatedKey;
    return {
      items: (result.Items ?? []) as Asset[],
      nextCursor: last ? encodeCursor(stringifyKey(last)) : null,
    };
  }
}

export class DynamoHarvestStore implements HarvestStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async get(assetId: string, harvestId: string): Promise<Harvest | undefined> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { assetId, harvestId } }),
    );
    return result.Item as Harvest | undefined;
  }

  async put(harvest: Harvest): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: harvest }));
  }

  async listByAsset(assetId: string, limit: number, cursor: string | undefined): Promise<Page<Harvest>> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "assetId = :assetId",
        ExpressionAttributeValues: { ":assetId": assetId },
        Limit: limit,
        ExclusiveStartKey: cursor ? decodeCursor(cursor) : undefined,
        ScanIndexForward: true,
      }),
    );
    const last = result.LastEvaluatedKey;
    return {
      items: (result.Items ?? []) as Harvest[],
      nextCursor: last ? encodeCursor(stringifyKey(last)) : null,
    };
  }
}

export class DynamoJobStore implements JobStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async get(jobId: string): Promise<Job | undefined> {
    const result = await this.doc.send(new GetCommand({ TableName: this.table, Key: { jobId } }));
    return result.Item as Job | undefined;
  }

  async put(job: Job): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: job }));
  }
}

export class DynamoIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async get(ownerId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { ownerId, idempotencyKey: key } }),
    );
    if (!result.Item) {
      return undefined;
    }
    const item = result.Item as { ownerId: string; idempotencyKey: string; asset: IdempotencyRecord["asset"] };
    return { ownerId: item.ownerId, key: item.idempotencyKey, asset: item.asset };
  }

  async put(record: IdempotencyRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { ownerId: record.ownerId, idempotencyKey: record.key, asset: record.asset },
      }),
    );
  }
}

export function stringifyKey(key: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(key)) {
    if (typeof v === "string") {
      out[k] = v;
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

export function createDynamoStores(doc: DynamoDBDocumentClient, tables: TableNames) {
  return {
    assets: new DynamoAssetStore(doc, tables.assets),
    harvests: new DynamoHarvestStore(doc, tables.harvests),
    jobs: new DynamoJobStore(doc, tables.jobs),
    idempotency: new DynamoIdempotencyStore(doc, tables.idempotency),
  };
}
