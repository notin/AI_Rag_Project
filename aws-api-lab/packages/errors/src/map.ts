import { CATALOG, problemType } from "./catalog.js";
import { isDomainError } from "./errors.js";
import type { ProblemContext, ProblemDetail } from "./problem.js";

const INTERNAL_DETAIL = "An unexpected error occurred.";

/**
 * The only function that is allowed to build an error HTTP body.
 * Handlers must not assemble problem+json themselves.
 *
 * Unknown errors become a generic 500. The original message and stack stay
 * in the log (caller's job) — they must never appear in `detail`.
 */
export function toProblem(err: unknown, ctx: ProblemContext): ProblemDetail {
  const instance = ctx.instance ?? `/requests/${ctx.requestId}`;

  if (isDomainError(err)) {
    return {
      type: err.type,
      title: err.title,
      status: err.status,
      detail: err.message,
      instance,
      code: err.code,
      requestId: ctx.requestId,
    };
  }

  return {
    type: problemType("INTERNAL"),
    title: CATALOG.INTERNAL.title,
    status: CATALOG.INTERNAL.status,
    detail: INTERNAL_DETAIL,
    instance,
    code: "INTERNAL",
    requestId: ctx.requestId,
  };
}

export const GENERIC_INTERNAL_DETAIL = INTERNAL_DETAIL;
