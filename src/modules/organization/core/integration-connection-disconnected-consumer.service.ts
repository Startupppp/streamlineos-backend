import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { ComposioGateway } from "../../integrations/core/composio.gateway";

const payloadSchema = z.object({
  connectionId: z.number().int(),
  composioConnectedAccountId: z.string().nullable(),
  userId: z.string(),
  orgId: z.string(),
  cause: z.string(),
});

const CONSUMER_NAME = "integration:connection-disconnected";

@Injectable()
export class IntegrationConnectionDisconnectedConsumer
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = "integration.connection.disconnected";
  private readonly logger = new Logger(IntegrationConnectionDisconnectedConsumer.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: OutboxConsumerRegistry,
    private readonly composio: ComposioGateway,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
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
        `integration.connection.disconnected ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
      );
      return;
    }

    const parseResult = payloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      this.logger.warn(
        `integration.connection.disconnected ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", parseResult.error.message);
      return;
    }

    const { composioConnectedAccountId, connectionId } = parseResult.data;

    if (!composioConnectedAccountId) {
      this.logger.debug(
        `integration.connection.disconnected ${event.eventId}: no composioConnectedAccountId for connection ${connectionId} — skipping`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", "no composioConnectedAccountId");
      return;
    }

    try {
      await this.composio.deleteConnectedAccount(composioConnectedAccountId);
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
      this.logger.log(
        `integration.connection.disconnected ${event.eventId}: deleted Composio account ${composioConnectedAccountId} for connection ${connectionId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `integration.connection.disconnected ${event.eventId}: failed to delete Composio account ${composioConnectedAccountId}: ${message}`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", message);
    }
  }
}
