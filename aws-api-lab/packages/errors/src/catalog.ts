/**
 * Stable machine codes. Clients branch on `code`, never on `detail`.
 * `type` is a documentation URI; it does not have to resolve.
 */
export const PROBLEM_TYPE_BASE = "https://aws-api-lab.dev/problems";

export const CATALOG = {
  ASSET_NOT_FOUND: {
    status: 404,
    title: "Asset not found",
  },
  HARVEST_NOT_FOUND: {
    status: 404,
    title: "Harvest not found",
  },
  JOB_NOT_FOUND: {
    status: 404,
    title: "Job not found",
  },
  VALIDATION_FAILED: {
    status: 422,
    title: "Validation failed",
  },
  BAD_CURSOR: {
    status: 422,
    title: "Invalid cursor",
  },
  CONFLICT: {
    status: 409,
    title: "Conflict",
  },
  PRECONDITION_FAILED: {
    status: 412,
    title: "Precondition failed",
  },
  THROTTLED: {
    status: 429,
    title: "Too many requests",
  },
  BAD_REQUEST: {
    status: 400,
    title: "Bad request",
  },
  UNAUTHORIZED: {
    status: 401,
    title: "Unauthorized",
  },
  /** Do not use this to hide that an asset id exists. Mask with 404. */
  FORBIDDEN: {
    status: 403,
    title: "Forbidden",
  },
  INTERNAL: {
    status: 500,
    title: "Internal error",
  },
} as const;

export type ErrorCode = keyof typeof CATALOG;

export const ERROR_CODES = Object.keys(CATALOG) as ErrorCode[];

export function problemType(code: ErrorCode): string {
  return `${PROBLEM_TYPE_BASE}/${code.toLowerCase().replaceAll("_", "-")}`;
}
