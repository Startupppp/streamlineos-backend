import { Injectable, type OnModuleInit } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollRuns } from "../../../db/schema";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { systemActor } from "../../../common/auth/system-actor";
import { PayrollPostingService } from "../payroll-posting.service";

export const PAYROLL_RUN_POSTING_INTENT_EVENT = "payroll.run.posting-intent";

const CONSUMER_NAME = "payroll:run:posting-intent";

const postingIntentPayloadSchema = z.object({
  runId: z.number().int().positive(),
  month: z.string().min(7).max(7),
  gross: z.string(),
  deductions: z.string(),
  net: z.string(),
  employerCost: z.string(),
  actorUserId: z.string().min(1),
  orgId: z.string().min(1),
});

@Injectable()
export class PayrollPostingIntentConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = PAYROLL_RUN_POSTING_INTENT_EVENT;

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

    if (!(await inbox.claim(CONSUMER_NAME, {
      eventId: event.eventId,
      organizationId: event.organizationId,
      aggregateType: event.aggregateType ?? undefined,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
    }))) return;

    const parsed = postingIntentPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", parsed.error.message);
      return;
    }

    if (parsed.data.orgId !== event.organizationId) {
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", "payload orgId mismatch");
      return;
    }

    const { runId, month, gross, deductions, net, employerCost, actorUserId } = parsed.data;
    const u = systemActor("payroll.run.finalize-posting", event.organizationId, actorUserId);

    try {
      await this.payrollPosting.postFinalized(u, runId, month, gross, deductions, net, employerCost);
      await this.db
        .update(payrollRuns)
        .set({ postingState: "posted" })
        .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, event.organizationId)));
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED");
    } catch (error: unknown) {
      await inbox.markProcessed(
        CONSUMER_NAME,
        event.eventId,
        "FAILED",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
}
