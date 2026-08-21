import { describe, expect, it } from "vitest";
import {
  ConflictError,
  GENERIC_INTERNAL_DETAIL,
  hiddenNotFound,
  isDomainError,
  NotFoundError,
  PreconditionFailedError,
  RFC9457_FIELDS,
  ThrottleError,
  toProblem,
  ValidationError,
  type ProblemDetail,
} from "./index.js";

const ctx = { requestId: "req-123", instance: "/v1/assets/abc" };

function rfcFieldsOf(problem: ProblemDetail): string[] {
  return RFC9457_FIELDS.filter((field) => problem[field] !== undefined && problem[field] !== "");
}

describe("toProblem", () => {
  it("maps NotFoundError to 404 ASSET_NOT_FOUND with all RFC fields", () => {
    const problem = toProblem(new NotFoundError("ASSET_NOT_FOUND", "asset abc was not found"), ctx);
    expect(problem.status).toBe(404);
    expect(problem.code).toBe("ASSET_NOT_FOUND");
    expect(problem.title).toBe("Asset not found");
    expect(problem.detail).toBe("asset abc was not found");
    expect(problem.requestId).toBe("req-123");
    expect(problem.instance).toBe("/v1/assets/abc");
    expect(problem.type).toContain("asset-not-found");
    expect(rfcFieldsOf(problem)).toEqual([...RFC9457_FIELDS]);
  });

  it("maps harvest and job not-found codes", () => {
    expect(toProblem(new NotFoundError("HARVEST_NOT_FOUND", "missing"), ctx).code).toBe("HARVEST_NOT_FOUND");
    expect(toProblem(new NotFoundError("JOB_NOT_FOUND", "missing"), ctx).code).toBe("JOB_NOT_FOUND");
  });

  it("maps ValidationError, including cursor and bad request", () => {
    expect(toProblem(new ValidationError("name required"), ctx)).toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
    expect(toProblem(new ValidationError("cursor is not valid", "BAD_CURSOR"), ctx)).toMatchObject({
      code: "BAD_CURSOR",
      status: 422,
    });
    expect(toProblem(new ValidationError("Idempotency-Key required", "BAD_REQUEST"), ctx)).toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
  });

  it("maps ConflictError, PreconditionFailedError, and ThrottleError", () => {
    expect(toProblem(new ConflictError("duplicate"), ctx)).toMatchObject({ code: "CONFLICT", status: 409 });
    expect(toProblem(new PreconditionFailedError("etag mismatch"), ctx)).toMatchObject({
      code: "PRECONDITION_FAILED",
      status: 412,
    });
    expect(toProblem(new ThrottleError("slow down"), ctx)).toMatchObject({ code: "THROTTLED", status: 429 });
  });

  it("masks existence with 404, never 403", () => {
    const problem = toProblem(hiddenNotFound("asset", "abc"), ctx);
    expect(problem.status).toBe(404);
    expect(problem.code).toBe("ASSET_NOT_FOUND");
    expect(problem.status).not.toBe(403);
    expect(isDomainError(hiddenNotFound("harvest", "h1"))).toBe(true);
  });

  it("turns unknown errors into a generic 500 and does not leak internals", () => {
    const err = new Error("ENOENT: no such table assets at ip-10-0-1-23");
    err.stack = "Error: ENOENT: no such table assets\n    at dynamodb.ts:12:1";
    const problem = toProblem(err, ctx);
    expect(problem.status).toBe(500);
    expect(problem.code).toBe("INTERNAL");
    expect(problem.detail).toBe(GENERIC_INTERNAL_DETAIL);
    expect(problem.detail).not.toContain("ENOENT");
    expect(problem.detail).not.toContain("assets");
    expect(problem.detail).not.toContain("10.0.1.23");
    expect(JSON.stringify(problem)).not.toContain("dynamodb.ts");
    expect(rfcFieldsOf(problem)).toEqual([...RFC9457_FIELDS]);
  });

  it("defaults instance to /requests/{requestId}", () => {
    const problem = toProblem(new ConflictError("x"), { requestId: "r-9" });
    expect(problem.instance).toBe("/requests/r-9");
  });
});
