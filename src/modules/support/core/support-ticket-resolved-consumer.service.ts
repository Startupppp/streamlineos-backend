import { Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { SupportCsatService } from "./support-csat.service";

const CONSUMER_NAME = "support:ticket-resolved";

const ticketResolvedPayloadSchema = z.object({
  ticketId: z.number(),
  orgId: z.string(),
  actorUserId: z.string(),
});

@Injectable()
export class SupportTicketResolvedConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = "support.ticket.resolved";
  private readonly logger = new Logger(SupportTicketResolvedConsumer.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly csat: SupportCsatService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const inbox = new InboxConsumer(this.db);

    const claimed = await inbox.claim(CONSUMER_NAME, {
      eventId: event.eventId,
      organizationId: event.organizationId,
      aggregateType: event.aggregateType ?? undefined,
      aggregateId: event.aggregateId ?? undefined,
      aggregateVersion: event.aggregateVersion,
    });
    if (!claimed) {
      this.logger.debug(
        `support.ticket.resolved ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
      );
      return;
    }

    const parseResult = ticketResolvedPayloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      this.logger.warn(
        `support.ticket.resolved ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", parseResult.error.message);
      return;
    }

    const { ticketId, orgId } = parseResult.data;

    try {
      await this.csat.createRequestForTicket(orgId, ticketId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        this.logger.debug(
          `support.ticket.resolved ${event.eventId}: ticket ${ticketId} not found in org ${orgId} — skipping CSAT`,
        );
        await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", "ticket not found");
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `support.ticket.resolved ${event.eventId}: CSAT request failed for ticket ${ticketId}: ${msg}`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", msg);
      return;
    }

    await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
    this.logger.log(
      `support.ticket.resolved ${event.eventId}: CSAT request created for ticket ${ticketId} org ${orgId}`,
    );
  }
}
