import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type { HarvestEvents, HarvestRequested } from "@lab/domain";

export class EventBridgeHarvestEvents implements HarvestEvents {
  constructor(
    private readonly client: EventBridgeClient,
    private readonly busName: string,
  ) {}

  async publishHarvestRequested(detail: HarvestRequested): Promise<void> {
    await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.busName,
            Source: "assets.api",
            DetailType: "HarvestRequested",
            Detail: JSON.stringify(detail),
          },
        ],
      }),
    );
  }
}
