import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { createAsset, type Ports } from "@lab/domain";
import { header, parseJsonBody } from "../http/event.js";
import { createdAsset } from "../http/respond.js";
import { withHttp } from "../http/with-http.js";

export async function createAssetHandler(
  ports: Ports,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  return withHttp(event, async (caller) => {
    const asset = await createAsset(ports, caller, header(event, "Idempotency-Key"), parseJsonBody(event));
    return createdAsset(asset);
  });
}
