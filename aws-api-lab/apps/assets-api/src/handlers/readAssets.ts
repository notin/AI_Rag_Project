import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getAsset, listAssets, listHarvests, type Ports } from "@lab/domain";
import { query } from "../http/event.js";
import { json, okAsset } from "../http/respond.js";
import { withHttp } from "../http/with-http.js";

export async function readAssets(ports: Ports, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  return withHttp(event, async (caller) => {
    const harvests = Boolean(event.resource?.includes("harvests") || event.path.includes("/harvests"));
    const assetId = event.pathParameters?.assetId;
    if (harvests && assetId) {
      const page = await listHarvests(
        ports,
        caller,
        assetId,
        parseOptionalInt(query(event, "limit")),
        query(event, "cursor"),
      );
      return json(200, page);
    }
    if (assetId) {
      return okAsset(await getAsset(ports, caller, assetId));
    }
    const page = await listAssets(
      ports,
      caller,
      parseOptionalInt(query(event, "limit")),
      query(event, "cursor"),
    );
    return json(200, page);
  });
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return Number(value);
}
