import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { InboxConsumer } from "../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../common/outbox/outbox-consumer.registry";
import { AblyService } from "./ably.service";

export const REALTIME_TOKEN_REVOCATION_EVENT = "realtime.token-revocation";

const payloadSchema = z.object({
  orgId: z.string().min(1),
  userId: z.string().min(1),
  channelId: z.number().int().positive(),
  membershipId: z.number().int().positive(),
});

const CONSUMER_NAME = "realtime:token-revocation";

@Injectable()
export class RealtimeTokenRevocationConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = REALTIME_TOKEN_REVOCATION_EVENT;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const inbox = new InboxConsumer(this.db);
    if (!(await inbox.claim(CONSUMER_NAME, {
      eventId: event.eventId,
      organizationId: event.organizationId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
    }))) return;

    const parsed = payloadSchema.safeParse(event.payload);
    if (!parsed.success || parsed.data.orgId !== event.organizationId) {
      const reason = parsed.success
        ? "token revocation payload organization does not match the outbox event"
        : parsed.error.message;
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", reason);
      return;
    }

    try {
      await this.ably.revokeUserTokens(parsed.data.userId);
      await this.ably.publishToUser(
        parsed.data.orgId,
        parsed.data.userId,
        "realtime:capability:refresh",
        {},
        { requireConfigured: true },
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }
}
