import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getJob, type Ports } from "@lab/domain";
import { pathParam } from "../http/event.js";
import { okJob } from "../http/respond.js";
import { withHttp } from "../http/with-http.js";

export async function getJobHandler(ports: Ports, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  return withHttp(event, async (caller) => {
    return okJob(await getJob(ports, caller, pathParam(event, "jobId")));
  });
}
