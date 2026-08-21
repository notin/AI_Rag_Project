import { CATALOG, problemType, type ErrorCode } from "./catalog.js";

const DOMAIN_ERROR = Symbol("DomainError");

export class DomainError extends Error {
  readonly [DOMAIN_ERROR] = true;
  readonly code: ErrorCode;
  readonly status: number;
  readonly title: string;
  readonly type: string;

  constructor(code: ErrorCode, detail: string) {
    super(detail);
    this.name = "DomainError";
    this.code = code;
    this.status = CATALOG[code].status;
    this.title = CATALOG[code].title;
    this.type = problemType(code);
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return (
    typeof err === "object" &&
    err !== null &&
    DOMAIN_ERROR in err &&
    (err as DomainError)[DOMAIN_ERROR] === true
  );
}

export class NotFoundError extends DomainError {
  constructor(code: "ASSET_NOT_FOUND" | "HARVEST_NOT_FOUND" | "JOB_NOT_FOUND", detail: string) {
    super(code, detail);
    this.name = "NotFoundError";
  }
}

/**
 * Existence-sensitive read/write: never 403. A 403 would teach the caller
 * that the id exists.
 */
export function hiddenNotFound(kind: "asset" | "harvest" | "job", id: string): NotFoundError {
  const code =
    kind === "asset" ? "ASSET_NOT_FOUND" : kind === "harvest" ? "HARVEST_NOT_FOUND" : "JOB_NOT_FOUND";
  return new NotFoundError(code, `${kind} ${id} was not found`);
}

export class ValidationError extends DomainError {
  constructor(detail: string, code: "VALIDATION_FAILED" | "BAD_CURSOR" | "BAD_REQUEST" = "VALIDATION_FAILED") {
    super(code, detail);
    this.name = "ValidationError";
  }
}

export class ConflictError extends DomainError {
  constructor(detail: string) {
    super("CONFLICT", detail);
    this.name = "ConflictError";
  }
}

export class PreconditionFailedError extends DomainError {
  constructor(detail: string) {
    super("PRECONDITION_FAILED", detail);
    this.name = "PreconditionFailedError";
  }
}

export class ThrottleError extends DomainError {
  constructor(detail: string) {
    super("THROTTLED", detail);
    this.name = "ThrottleError";
  }
}
