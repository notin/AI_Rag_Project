import { ValidationError } from "@lab/errors";

export function decodeCursor(cursor: string): Record<string, string> {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        throw new Error("non-string");
      }
      record[key] = value;
    }
    return record;
  } catch {
    throw new ValidationError("cursor is not a valid nextCursor", "BAD_CURSOR");
  }
}

export function encodeCursor(key: Record<string, string>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

export function parseLimit(limit: number | undefined): number {
  const value = limit ?? 25;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new ValidationError("limit must be an integer from 1 to 100", "VALIDATION_FAILED");
  }
  return value;
}
