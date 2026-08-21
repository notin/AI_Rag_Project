import { DomainError } from "@lab/errors";
import type { APIGatewayProxyEvent } from "aws-lambda";

export function header(event: APIGatewayProxyEvent, name: string): string | undefined {
  const headers = event.headers ?? {};
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] ?? undefined;
}

export function requestId(event: APIGatewayProxyEvent): string {
  return header(event, "x-request-id") ?? event.requestContext.requestId ?? "missing-request-id";
}

export function instance(event: APIGatewayProxyEvent): string {
  return event.path;
}

export function callerId(event: APIGatewayProxyEvent): string {
  const authorizer = event.requestContext.authorizer as
    | { sub?: string; claims?: { sub?: string } }
    | null
    | undefined;
  const sub = authorizer?.sub ?? authorizer?.claims?.sub;
  if (!sub) {
    throw new DomainError("UNAUTHORIZED", "Authentication required");
  }
  return sub;
}

export function parseJsonBody(event: APIGatewayProxyEvent): unknown {
  if (!event.body) {
    return {};
  }
  try {
    return JSON.parse(event.body) as unknown;
  } catch {
    throw new DomainError("BAD_REQUEST", "Request body is not valid JSON");
  }
}

export function query(event: APIGatewayProxyEvent, name: string): string | undefined {
  return event.queryStringParameters?.[name] ?? undefined;
}

export function pathParam(event: APIGatewayProxyEvent, name: string): string {
  const value = event.pathParameters?.[name];
  if (!value) {
    throw new DomainError("BAD_REQUEST", `Missing path parameter ${name}`);
  }
  return value;
}
