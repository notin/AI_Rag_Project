import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type { Ports } from "@lab/domain";
import { callerId, instance, requestId } from "./event.js";
import { problemFrom } from "./respond.js";

export async function withHttp(
  event: APIGatewayProxyEvent,
  fn: (caller: string) => Promise<APIGatewayProxyResult>,
): Promise<APIGatewayProxyResult> {
  try {
    return await fn(callerId(event));
  } catch (err) {
    return problemFrom(err, requestId(event), instance(event));
  }
}

export type Handler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

export function bind(ports: Ports, impl: (ports: Ports, event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>): Handler {
  return (event) => impl(ports, event);
}
