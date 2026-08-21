import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createMemoryPorts, type HarvestEvents, type HarvestRequested, type Ports } from "@lab/domain";
import { createDynamoStores } from "./dynamodb/stores.js";
import { tableNamesFromEnv } from "./dynamodb/tables.js";
import { EventBridgeHarvestEvents } from "./events/eventbridge.js";

/** Clients live outside the handler so they survive across warm invocations. */
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

class LogHarvestEvents implements HarvestEvents {
  async publishHarvestRequested(detail: HarvestRequested): Promise<void> {
    console.log(JSON.stringify({ msg: "HarvestRequested", detail }));
  }
}

export function createPortsFromEnv(env: NodeJS.ProcessEnv = process.env): Ports {
  if (env.USE_MEMORY === "true") {
    return createMemoryPorts();
  }
  const stores = createDynamoStores(dynamo, tableNamesFromEnv(env));
  const bus = env.EVENT_BUS_NAME;
  const events = bus ? new EventBridgeHarvestEvents(new EventBridgeClient({}), bus) : new LogHarvestEvents();
  return {
    ...stores,
    events,
    clock: { now: () => new Date().toISOString() },
    ids: { uuid: () => crypto.randomUUID() },
  };
}

let cached: Ports | undefined;

export function getPorts(): Ports {
  cached ??= createPortsFromEnv();
  return cached;
}
