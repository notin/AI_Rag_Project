export type TableNames = {
  assets: string;
  harvests: string;
  jobs: string;
  idempotency: string;
};

export const ASSETS_OWNER_INDEX = "gsi-owner";

export function tableNamesFromEnv(env: NodeJS.ProcessEnv = process.env): TableNames {
  const required = ["ASSETS_TABLE", "HARVESTS_TABLE", "JOBS_TABLE", "IDEMPOTENCY_TABLE"] as const;
  const names: Partial<TableNames> = {};
  const missing: string[] = [];
  for (const key of required) {
    const value = env[key];
    if (!value) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new Error(`missing table env: ${missing.join(", ")}`);
  }
  return {
    assets: env.ASSETS_TABLE as string,
    harvests: env.HARVESTS_TABLE as string,
    jobs: env.JOBS_TABLE as string,
    idempotency: env.IDEMPOTENCY_TABLE as string,
  };
}
