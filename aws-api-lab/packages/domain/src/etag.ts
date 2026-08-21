import { ValidationError } from "@lab/errors";

export function etagFromVersion(version: number): string {
  return `W/"${version}"`;
}

export function versionFromIfMatch(ifMatch: string | undefined): number {
  if (!ifMatch || ifMatch.trim() === "") {
    throw new ValidationError("If-Match header is required", "BAD_REQUEST");
  }
  const match = /^W\/"(\d+)"$/.exec(ifMatch.trim());
  if (!match?.[1]) {
    throw new ValidationError('If-Match must be a weak ETag of the form W/"{version}"', "BAD_REQUEST");
  }
  return Number(match[1]);
}
