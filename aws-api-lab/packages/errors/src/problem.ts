import type { ErrorCode } from "./catalog.js";

/** RFC 9457 Problem Details plus the extensions this API guarantees. */
export type ProblemDetail = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: ErrorCode;
  requestId: string;
};

export type ProblemContext = {
  requestId: string;
  /** Request path or `/requests/{requestId}` when the path is unknown. */
  instance?: string;
};

export const RFC9457_FIELDS = ["type", "title", "status", "detail", "instance"] as const;
