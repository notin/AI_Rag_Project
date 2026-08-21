import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOG, ERROR_CODES, RFC9457_FIELDS } from "./index.js";

const specPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../openapi/assets@v1.yaml");
const spec = readFileSync(specPath, "utf8");

describe("error catalog contract", () => {
  it("codes are stable UPPER_SNAKE_CASE", () => {
    expect(ERROR_CODES.length).toBeGreaterThan(0);
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });

  it("every catalog code is documented in the OpenAPI x-error-codes list", () => {
    for (const code of ERROR_CODES) {
      expect(spec).toContain(`code: ${code}`);
    }
  });

  it("ProblemDetail schema requires the five RFC 9457 fields plus code and requestId", () => {
    expect(spec).toContain("application/problem+json");
    expect(spec).toMatch(/required:\s*\[type, title, status, detail, instance, code, requestId\]/);
    for (const field of RFC9457_FIELDS) {
      expect(spec).toContain(`${field}:`);
    }
  });

  it("documents cursor pagination and rejects offset", () => {
    expect(spec).toContain("nextCursor");
    expect(spec.toLowerCase()).toContain("offset pagination is rejected");
    expect(spec).toContain("LastEvaluatedKey");
  });

  it("catalog status codes match the OpenAPI x-error-codes entries", () => {
    for (const code of ERROR_CODES) {
      const block = spec.split(`code: ${code}`)[1]?.slice(0, 80) ?? "";
      expect(block).toContain(`status: ${CATALOG[code].status}`);
    }
  });
});
