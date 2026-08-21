import { getPorts } from "./compose.js";
import { createAssetHandler } from "./handlers/createAsset.js";
import { createHarvestHandler } from "./handlers/createHarvest.js";
import { getJobHandler } from "./handlers/getJob.js";
import { readAssets } from "./handlers/readAssets.js";
import { writeAsset } from "./handlers/writeAsset.js";

export const readAssetsHandler = (event: Parameters<typeof readAssets>[1]) => readAssets(getPorts(), event);
export const createAssetLambda = (event: Parameters<typeof createAssetHandler>[1]) =>
  createAssetHandler(getPorts(), event);
export const writeAssetHandler = (event: Parameters<typeof writeAsset>[1]) => writeAsset(getPorts(), event);
export const createHarvestLambda = (event: Parameters<typeof createHarvestHandler>[1]) =>
  createHarvestHandler(getPorts(), event);
export const getJobLambda = (event: Parameters<typeof getJobHandler>[1]) => getJobHandler(getPorts(), event);

export { createAssetHandler, createHarvestHandler, getJobHandler, readAssets, writeAsset };
export { createPortsFromEnv } from "./compose.js";
