import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { AccessService } from "../../access/access.service";
import { invStockLowPayloadSchema } from "./dto/inv-stock-low-payload.schema";
import { INVENTORY_COMMAND_EVENTS } from "../stock-engine/command-events";

const CONSUMER_NAME = "inventory:inv-stock-low";

@Injectable()
export class InvStockLowConsumerService
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = "inventory.stock.low";
  private readonly logger = new Logger(InvStockLowConsumerService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    private readonly registry: OutboxConsumerRegistry,
    private readonly access: AccessService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    /**
     * B3. A stockout is now announced under its own name, and the buyer still
     * has to hear about it — an outage is the most urgent buying signal there
     * is. Registered as a second consumer sharing `handle`, which is safe
     * because `InboxConsumer.claim` keys on the event id: the two names are two
     * different events, never the same one delivered twice.
     */
    this.registry.register({
      eventType: INVENTORY_COMMAND_EVENTS.STOCK_OUT,
      handle: (event) => this.handle(event),
    });
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const inbox = new InboxConsumer(this.db);

    const claimed = await inbox.claim(CONSUMER_NAME, {
      eventId: event.eventId,
      organizationId: event.organizationId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
    });
    if (!claimed) {
      this.logger.debug(
        `inventory.stock.low ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
      );
      return;
    }

    const parseResult = invStockLowPayloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      this.logger.warn(
        `inventory.stock.low ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(
        CONSUMER_NAME,
        event.eventId,
        "FAILED",
        parseResult.error.message,
      );
      return;
    }

    const { productVariantId } = parseResult.data;
    const orgId = event.organizationId;

    const members = await this.access.membersWithPermission(
      orgId,
      "inventory:replenishment:manage",
    );

    if (members.length === 0) {
      this.logger.debug(
        `inventory.stock.low ${event.eventId}: no recipients for org ${orgId} — skipping`,
      );
      await inbox.markProcessed(
        CONSUMER_NAME,
        event.eventId,
        "SKIPPED",
        "no recipients",
      );
      return;
    }

    const targetUserIds = members.map((m) => m.userId);

    await this.dispatch.emit({
      orgId,
      dedupeKey: event.eventId,
      eventKey: "inventory.stock.low",
      targetUserIds,
      entityType: "inv_product_variant",
      entityId: String(productVariantId),
    });

    await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);

    this.logger.log(
      `inventory.stock.low ${event.eventId}: dispatched to ${targetUserIds.length} recipients for org ${orgId}`,
    );
  }
}
