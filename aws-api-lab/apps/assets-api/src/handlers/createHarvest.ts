import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { requestHarvest, type Ports } from "@lab/domain";
import { header, parseJsonBody, pathParam } from "../http/event.js";
import { acceptedJob } from "../http/respond.js";
import { withHttp } from "../http/with-http.js";

export async function createHarvestHandler(
  ports: Ports,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  return withHttp(event, async (caller) => {
    const job = await requestHarvest(
      ports,
      caller,
      pathParam(event, "assetId"),
      header(event, "Idempotency-Key"),
      parseJsonBody(event),
    );
    return acceptedJob(job);
  });
}
