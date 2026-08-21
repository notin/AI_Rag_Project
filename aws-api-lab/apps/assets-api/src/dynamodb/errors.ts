import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ConflictError, PreconditionFailedError } from "@lab/errors";

export function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof ConditionalCheckFailedException ||
    (typeof err === "object" && err !== null && "name" in err && (err as { name: string }).name === "ConditionalCheckFailedException");
}

export function conflictOr(err: unknown): never {
  if (isConditionalCheckFailed(err)) {
    throw new ConflictError("asset already exists");
  }
  throw err;
}

export function preconditionOr(err: unknown): never {
  if (isConditionalCheckFailed(err)) {
    throw new PreconditionFailedError("If-Match does not match the current ETag");
  }
  throw err;
}
