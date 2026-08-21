import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("package hygiene", () => {
  it("does not depend on aws-lambda or the AWS SDK", () => {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    expect(names.some((name) => name === "aws-lambda" || name.startsWith("@aws-sdk") || name === "@types/aws-lambda")).toBe(
      false,
    );
  });
});
