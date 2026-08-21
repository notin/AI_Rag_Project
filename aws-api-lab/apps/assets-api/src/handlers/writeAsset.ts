import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { deleteAsset, patchAsset, replaceAsset, type Ports } from "@lab/domain";
import { header, parseJsonBody, pathParam } from "../http/event.js";
import { noContent, okAsset } from "../http/respond.js";
import { withHttp } from "../http/with-http.js";
import { DomainError } from "@lab/errors";

export async function writeAsset(ports: Ports, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  return withHttp(event, async (caller) => {
    const assetId = pathParam(event, "assetId");
    const ifMatch = header(event, "If-Match");
    const method = event.httpMethod.toUpperCase();
    if (method === "PUT") {
      return okAsset(await replaceAsset(ports, caller, assetId, ifMatch, parseJsonBody(event)));
    }
    if (method === "PATCH") {
      return okAsset(await patchAsset(ports, caller, assetId, ifMatch, parseJsonBody(event)));
    }
    if (method === "DELETE") {
      await deleteAsset(ports, caller, assetId, ifMatch);
      return noContent();
    }
    throw new DomainError("BAD_REQUEST", `Unsupported method ${method}`);
  });
}
