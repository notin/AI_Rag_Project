import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { ConflictError, PreconditionFailedError } from "@lab/errors";
import { decodeCursor, encodeCursor } from "@lab/domain";
import { conflictOr, preconditionOr } from "./errors.js";
import { stringifyKey } from "./stores.js";

describe("dynamodb adapter helpers", () => {
  it("maps conditional check failed to Conflict on create and 412 on update", () => {
    const failed = new ConditionalCheckFailedException({
      message: "The conditional request failed",
      $metadata: {},
    });
    expect(() => conflictOr(failed)).toThrow(ConflictError);
    expect(() => preconditionOr(failed)).toThrow(PreconditionFailedError);
  });

  it("round-trips LastEvaluatedKey as nextCursor", () => {
    const key = stringifyKey({ ownerId: "user-1", assetId: "a2" });
    const cursor = encodeCursor(key);
    expect(decodeCursor(cursor)).toEqual(key);
  });
});
