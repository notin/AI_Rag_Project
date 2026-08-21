import { toProblem } from "@lab/errors";
import { etagFromVersion, type Asset, type Job } from "@lab/domain";
import type { APIGatewayProxyResult } from "aws-lambda";

const PROBLEM = "application/problem+json";
const JSON_CT = "application/json";

export function json(
  statusCode: number,
  body: unknown,
  extra: Record<string, string> = {},
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "content-type": JSON_CT, ...extra },
    body: JSON.stringify(body),
  };
}

export function noContent(): APIGatewayProxyResult {
  return { statusCode: 204, headers: {}, body: "" };
}

export function createdAsset(asset: Asset): APIGatewayProxyResult {
  return json(201, asset, {
    Location: `/v1/assets/${asset.assetId}`,
    ETag: etagFromVersion(asset.version),
  });
}

export function okAsset(asset: Asset): APIGatewayProxyResult {
  return json(200, asset, { ETag: etagFromVersion(asset.version) });
}

export function acceptedJob(job: Job): APIGatewayProxyResult {
  const publicJob = {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    assetId: job.assetId,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  return json(202, publicJob, { Location: `/v1/jobs/${job.jobId}` });
}

export function okJob(job: Job): APIGatewayProxyResult {
  return json(200, {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    assetId: job.assetId,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
}

export function problemFrom(err: unknown, reqId: string, path: string): APIGatewayProxyResult {
  const problem = toProblem(err, { requestId: reqId, instance: path });
  return {
    statusCode: problem.status,
    headers: { "content-type": PROBLEM },
    body: JSON.stringify(problem),
  };
}
