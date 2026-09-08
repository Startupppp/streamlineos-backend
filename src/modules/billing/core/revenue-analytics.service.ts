import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, gte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { revenueEvents, subscriptions } from "../../../db/schema";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { type OutboxEventInput } from "../../../common/outbox/outbox-event-schema";
import { type DbOrTx } from "../../../common/rbac/access-invalidate";
import { PLAN_PRICES_PAISE } from "./plan-entitlements.constants";
import {
  REVENUE_EVENT_TYPE,
  revenueEventPayloadSchema,
  type RevenueEventInput,
} from "./revenue-events";
import { summariseMovements, type RevenueMovement } from "./revenue-metrics";
import { deterministicEventId } from "./deterministic-event-id";

const CONSUMER_NAME = "billing:revenue-event";

// Owns both ends of the ledger: producers emit inside their transaction, this consumer writes the row.
@Injectable()
export class RevenueAnalyticsService implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = REVENUE_EVENT_TYPE;
  private readonly logger = new Logger(RevenueAnalyticsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // Each event is its own aggregate, so the inbox version fence never suppresses a sibling. A
  // caller carrying a dedupeKey gets a stable id instead, so re-running one movement conflicts
  // on uniq_outbox_events_event_id rather than committing a second revenue row.
  private envelope(input: RevenueEventInput): OutboxEventInput {
    const eventId =
      input.dedupeKey === undefined
        ? randomUUID()
        : deterministicEventId(REVENUE_EVENT_TYPE, input.orgId, input.type, input.dedupeKey);
    return {
      eventId,
      organizationId: input.orgId,
      aggregateType: "revenue_event",
      aggregateId: eventId,
      aggregateVersion: 1,
      eventType: REVENUE_EVENT_TYPE,
      payload: {
        type: input.type,
        orgId: input.orgId,
        plan: input.plan ?? null,
        previousPlan: input.previousPlan ?? null,
        mrr: input.mrr,
        amount: input.amount ?? null,
        currency: input.currency,
        metadata: input.metadata ?? null,
      },
      occurredAt: new Date(),
    };
  }

  async emit(tx: DbOrTx, input: RevenueEventInput): Promise<void> {
    await OutboxWriter.emit(tx, this.envelope(input));
  }

  // One outbox INSERT for a whole sweep's worth of movements. The envelope is built by the same
  // method `emit` uses, so a batched emission and N single ones are the same rows.
  async emitMany(tx: DbOrTx, inputs: readonly RevenueEventInput[]): Promise<void> {
    await OutboxWriter.emitMany(tx, inputs.map((input) => this.envelope(input)));
  }

  // The relay holds the tenant transaction; a failure is rethrown so the outbox retries it.
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
      this.logger.debug(`revenue event ${event.eventId} already applied — skipping`);
      return;
    }

    const parsed = revenueEventPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", parsed.error.message);
      return;
    }
    const payload = parsed.data;

    await this.db.transaction(async (tx) => {
      await tx.insert(revenueEvents).values({
        type: payload.type,
        orgId: event.organizationId,
        plan: payload.plan ?? undefined,
        previousPlan: payload.previousPlan ?? undefined,
        mrr: payload.mrr,
        amount: payload.amount ?? undefined,
        currency: payload.currency ?? undefined,
        metadata: payload.metadata ?? undefined,
      });
      await new InboxConsumer(tx).markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
    });
  }

  // MRR is read from subscription state: summing new_subscription rows double-counted every re-subscribe.
  async getMetrics(orgId: string) {
    const [statusRows, movementRows] = await Promise.all([
      this.db
        .select({
          status: subscriptions.status,
          plan: subscriptions.plan,
          count: sql<number>`count(*)::int`,
        })
        .from(subscriptions)
        .where(eq(subscriptions.orgId, orgId))
        .groupBy(subscriptions.status, subscriptions.plan),
      this.db
        .select({
          type: revenueEvents.type,
          mrr: sql<number>`coalesce(sum(${revenueEvents.mrr}), 0)::int`,
          count: sql<number>`count(*)::int`,
          recentMrr: sql<number>`coalesce(sum(${revenueEvents.mrr}) filter (where ${revenueEvents.createdAt} >= now() - interval '30 days'), 0)::int`,
        })
        .from(revenueEvents)
        .where(eq(revenueEvents.orgId, orgId))
        .groupBy(revenueEvents.type),
    ]);

    let mrr = 0;
    let totalActive = 0;
    let totalTrial = 0;
    for (const row of statusRows) {
      const count = Number(row.count ?? 0);
      if (row.status === "ACTIVE") {
        totalActive += count;
        mrr += (PLAN_PRICES_PAISE[row.plan] ?? 0) * count;
      }
      if (row.status === "TRIAL") totalTrial += count;
    }

    const movements: RevenueMovement[] = movementRows.map((row) => ({
      type: row.type,
      mrr: Number(row.mrr ?? 0),
      count: Number(row.count ?? 0),
      recentMrr: Number(row.recentMrr ?? 0),
    }));

    return summariseMovements({ mrr, totalActive, totalTrial, movements });
  }

  async getTimeSeriesData(period: string, orgId: string) {
    const months = period === "3m" ? 3 : period === "12m" ? 12 : 6;
    const since = new Date();
    since.setMonth(since.getMonth() - months);

    const events = await this.db
      .select({
        type: revenueEvents.type,
        mrr: revenueEvents.mrr,
        createdAt: revenueEvents.createdAt,
      })
      .from(revenueEvents)
      .where(and(eq(revenueEvents.orgId, orgId), gte(revenueEvents.createdAt, since)))
      .orderBy(revenueEvents.createdAt);

    const byMonth: Record<
      string,
      { month: string; newMrr: number; churnMrr: number; netNew: number }
    > = {};

    for (const event of events) {
      const key = event.createdAt.toISOString().slice(0, 7);
      const bucket = byMonth[key] ?? { month: key, newMrr: 0, churnMrr: 0, netNew: 0 };
      byMonth[key] = bucket;
      if (
        event.type === "new_subscription" ||
        event.type === "upgrade" ||
        event.type === "reactivation"
      ) {
        bucket.newMrr += event.mrr;
      }
      if (event.type === "churn" || event.type === "downgrade") {
        bucket.churnMrr += event.mrr;
      }
      bucket.netNew = bucket.newMrr - bucket.churnMrr;
    }

    return Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
  }

  async reconcile(orgId: string): Promise<{ reportedMrr: number; subscriptionMrr: number; reconciles: boolean }> {
    const rows = await this.db
      .select({ plan: subscriptions.plan, count: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "ACTIVE")))
      .groupBy(subscriptions.plan);

    const subscriptionMrr = rows.reduce(
      (total, row) => total + (PLAN_PRICES_PAISE[row.plan] ?? 0) * Number(row.count ?? 0),
      0,
    );
    const { mrr } = await this.getMetrics(orgId);
    return { reportedMrr: mrr, subscriptionMrr, reconciles: mrr === subscriptionMrr };
  }

  async countEventsSince(type: RevenueEventInput["type"], since: Date, orgId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(revenueEvents)
      .where(and(eq(revenueEvents.orgId, orgId), eq(revenueEvents.type, type), gte(revenueEvents.createdAt, since)));
    return Number(rows[0]?.count ?? 0);
  }
}
