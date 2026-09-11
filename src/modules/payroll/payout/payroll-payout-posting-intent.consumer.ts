import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { systemActor } from "../../../common/auth/system-actor";
import { PayrollPostingService } from "../payroll-posting.service";

export const PAYROLL_RUN_PAYOUT_POSTING_INTENT_EVENT =
  "payroll.run.payout-posting-intent";

const CONSUMER_NAME = "payroll:run:payout-posting-intent";

const payoutPostingIntentPayloadSchema = z.object({
  runId: z.number().int().positive(),
  month: z.string().min(7).max(7),
  net: z.string(),
  actorUserId: z.string().min(1),
  orgId: z.string().min(1),
});

/**
 * Marking a run PAID and posting its bank-disbursement journal must not be able to
 * come apart. The intent is committed on the same transaction that flips the run to
 * PAID, so a crash before delivery leaves a retryable outbox row rather than a run
 * that is paid in payroll and invisible in accounting.
 */
@Injectable()
export class PayrollPayoutPostingIntentConsumer
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = PAYROLL_RUN_PAYOUT_POSTING_INTENT_EVENT;

  private readonly logger = new Logger(PayrollPayoutPostingIntentConsumer.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly payrollPosting: PayrollPostingService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const inbox = new InboxConsumer(this.db);

    if (
      !(await inbox.claim(CONSUMER_NAME, {
        eventId: event.eventId,
        organizationId: event.organizationId,
        aggregateType: event.aggregateType ?? undefined,
        aggregateId: event.aggregateId,
        aggregateVersion: event.aggregateVersion,
      }))
    )
      return;

    const parsed = payoutPostingIntentPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      this.logger.error(
        `payout posting intent ${event.eventId} is terminally undeliverable: ${parsed.error.message}`,
      );
      await inbox.markProcessed(
        CONSUMER_NAME,
        event.eventId,
        "FAILED",
        parsed.error.message,
      );
      return;
    }

    if (parsed.data.orgId !== event.organizationId) {
      this.logger.error(
        `payout posting intent ${event.eventId} is terminally undeliverable: payload orgId mismatch`,
      );
      await inbox.markProcessed(
        CONSUMER_NAME,
        event.eventId,
        "FAILED",
        "payload orgId mismatch",
      );
      return;
    }

    const { runId, month, net, actorUserId } = parsed.data;
    const u = systemActor(
      "payroll.run.payout-posting",
      event.organizationId,
      actorUserId,
    );

    try {
      await this.payrollPosting.postPaid(u, runId, month, net);
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await inbox.markProcessed(
        CONSUMER_NAME,
        event.eventId,
        "FAILED",
        message,
      );
      throw error;
    }
  }
}
