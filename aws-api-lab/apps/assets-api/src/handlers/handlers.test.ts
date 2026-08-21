import { describe, expect, it } from "vitest";
import { createMemoryPorts, MemoryHarvestStore } from "@lab/domain";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { createAssetHandler } from "./createAsset.js";
import { createHarvestHandler } from "./createHarvest.js";
import { readAssets } from "./readAssets.js";
import { writeAsset } from "./writeAsset.js";

const caller = "user-1";

function event(overrides: Partial<APIGatewayProxyEvent> & { httpMethod: string; path: string }): APIGatewayProxyEvent {
  return {
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    body: null,
    isBase64Encoded: false,
    resource: overrides.path,
    requestContext: {
      requestId: "req-1",
      authorizer: { sub: caller },
    } as APIGatewayProxyEvent["requestContext"],
    ...overrides,
  } as APIGatewayProxyEvent;
}

describe("thin handlers", () => {
  it("create then get returns ETag, stale PUT is 412, matching PUT is 200", async () => {
    const ports = createMemoryPorts();
    const created = await createAssetHandler(
      ports,
      event({
        httpMethod: "POST",
        path: "/v1/assets",
        headers: { "Idempotency-Key": "idempotency-key-1" },
        body: JSON.stringify({ name: "Clip" }),
      }),
    );
    expect(created.statusCode).toBe(201);
    expect(created.headers?.ETag).toBe('W/"1"');
    const asset = JSON.parse(created.body) as { assetId: string };

    const got = await readAssets(
      ports,
      event({
        httpMethod: "GET",
        path: `/v1/assets/${asset.assetId}`,
        pathParameters: { assetId: asset.assetId },
      }),
    );
    expect(got.statusCode).toBe(200);
    expect(got.headers?.ETag).toBe('W/"1"');

    const stale = await writeAsset(
      ports,
      event({
        httpMethod: "PUT",
        path: `/v1/assets/${asset.assetId}`,
        pathParameters: { assetId: asset.assetId },
        headers: { "If-Match": 'W/"0"' },
        body: JSON.stringify({ name: "Clip", status: "active" }),
      }),
    );
    expect(stale.statusCode).toBe(412);
    const problem = JSON.parse(stale.body) as { code: string };
    expect(problem.code).toBe("PRECONDITION_FAILED");

    const ok = await writeAsset(
      ports,
      event({
        httpMethod: "PUT",
        path: `/v1/assets/${asset.assetId}`,
        pathParameters: { assetId: asset.assetId },
        headers: { "If-Match": 'W/"1"' },
        body: JSON.stringify({ name: "Clip 2", status: "active" }),
      }),
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.headers?.ETag).toBe('W/"2"');
  });

  it("POST harvest is 202 and does not write a harvest row", async () => {
    const harvests = new MemoryHarvestStore();
    const ports = createMemoryPorts({ harvests });
    const created = await createAssetHandler(
      ports,
      event({
        httpMethod: "POST",
        path: "/v1/assets",
        headers: { "Idempotency-Key": "idempotency-key-1" },
        body: JSON.stringify({ name: "Clip" }),
      }),
    );
    const asset = JSON.parse(created.body) as { assetId: string };
    const accepted = await createHarvestHandler(
      ports,
      event({
        httpMethod: "POST",
        path: `/v1/assets/${asset.assetId}/harvests`,
        pathParameters: { assetId: asset.assetId },
        headers: { "Idempotency-Key": "idempotency-harvest-1" },
        body: "{}",
      }),
    );
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers?.Location).toMatch(/^\/v1\/jobs\//);
    expect(harvests.putCount).toBe(0);
  });
});
