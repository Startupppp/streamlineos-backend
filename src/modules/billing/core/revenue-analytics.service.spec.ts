import { ZodError } from "zod";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { revenueEvents, subscriptions } from "../../../db/schema";
import { inboxRecords, outboxEvents } from "../../../db/schema/common/outbox";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { type DbOrTx } from "../../../common/rbac/access-invalidate";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { PLAN_PRICES_PAISE } from "./plan-entitlements.constants";

interface DbSeed {
  claimable?: boolean;
  allowedOrgId?: string;
  subscriptionRows?: Array<{ orgId?: string; status: string; plan: string; count: number }>;
  movementRows?: Array<{ orgId?: string; type: string; mrr: number; count: number; recentMrr: number }>;
  revenueInsertRejects?: Error;
}

// db.transaction invokes its callback: the revenue row and its inbox fence both live inside it.
function makeDb(seed: DbSeed = {}) {
  const store = {
    outbox: [] as Array<Record<string, unknown>>,
    revenue: [] as Array<Record<string, unknown>>,
    inboxClaims: [] as Array<Record<string, unknown>>,
    inboxOutcomes: [] as Array<Record<string, unknown>>,
    transactions: 0,
  };
  const claimable = seed.claimable ?? true;

  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      if (table === outboxEvents) store.outbox.push(values);
      if (table === inboxRecords) store.inboxClaims.push(values);
      if (table === revenueEvents) {
        if (seed.revenueInsertRejects) return Promise.reject(seed.revenueInsertRejects);
        store.revenue.push(values);
      }
      const rows = claimable || table !== inboxRecords ? [{ id: 1 }] : [];
      return {
        onConflictDoNothing: () => ({ returning: () => Promise.resolve(rows) }),
        returning: () => Promise.resolve(rows),
        then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
      };
    },
  });

  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        if (table === inboxRecords) store.inboxOutcomes.push(values);
        return Promise.resolve([]);
      },
    }),
  });

  // `where` models the real predicate: only reconcile filters, and it filters to ACTIVE.
  const select = () => ({
    from: (table: unknown) => {
      const all = table === subscriptions ? (seed.subscriptionRows ?? []) : (seed.movementRows ?? []);
      const scoped = all.filter(
        (row) =>
          !("orgId" in row) || row.orgId === seed.allowedOrgId,
      );
      const active = scoped.filter((row) => !("status" in row) || row.status === "ACTIVE");
      const resolved = Promise.resolve(scoped);
      const query = {
        groupBy: (...columns: unknown[]) => Promise.resolve(columns.length === 1 ? active : scoped),
        where: () => query,
        orderBy: () => resolved,
        then: (resolve: (value: typeof scoped) => unknown) => resolved.then(resolve),
      };
      return query;
    },
  });

  const tx = { insert, update, select, execute: jest.fn().mockResolvedValue([]) };

  return {
    insert,
    update,
    select,
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => {
      store.transactions += 1;
      return fn(tx);
    }),
    _store: store,
  };
}

async function build(db: ReturnType<typeof makeDb>) {
  const registry = { register: jest.fn(), get: jest.fn() };
  const module = await Test.createTestingModule({
    providers: [
      RevenueAnalyticsService,
      { provide: DRIZZLE, useValue: db },
      { provide: OutboxConsumerRegistry, useValue: registry },
    ],
  }).compile();
  return {
    service: module.get(RevenueAnalyticsService),
    registry,
    // The handle the service is injected with, so emit is typed without forcing the double's type.
    tx: module.get<DbOrTx>(DRIZZLE),
  };
}

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function makeEvent(payload: Record<string, unknown>): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: "org1",
    aggregateType: "revenue_event",
    aggregateId: EVENT_ID,
    aggregateVersion: 1,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "IN_FLIGHT",
    eventType: "billing.revenue-event",
    payload,
    occurredAt: new Date("2026-08-27T00:00:00.000Z"),
    publishedAt: null,
    leaseExpiresAt: null,
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date("2026-08-27T00:00:00.000Z"),
  };
}

describe("recording happens through the outbox so it cannot be forgotten on a new path", () => {
  it("registers itself as the consumer for its own event type", async () => {
    const { service, registry } = await build(makeDb());
    service.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(service);
    expect(service.eventType).toBe("billing.revenue-event");
  });

  it("emits into the caller's transaction rather than writing the revenue row directly", async () => {
    const db = makeDb();
    const { service, tx } = await build(db);

    await service.emit(tx, { type: "new_subscription", orgId: "org1", plan: "STARTER", mrr: 99_900 });

    expect(db._store.outbox).toHaveLength(1);
    expect(db._store.revenue).toHaveLength(0);
    expect(db._store.outbox[0]).toMatchObject({
      eventType: "billing.revenue-event",
      organizationId: "org1",
      aggregateType: "revenue_event",
      aggregateVersion: 1,
    });
  });

  it("gives every event its own aggregate id so a sibling is never suppressed as out-of-order", async () => {
    const db = makeDb();
    const { service, tx } = await build(db);

    await service.emit(tx, { type: "new_subscription", orgId: "org1", mrr: 1 });
    await service.emit(tx, { type: "upgrade", orgId: "org1", mrr: 2 });

    const [first, second] = db._store.outbox;
    expect(first?.aggregateId).not.toBe(second?.aggregateId);
    expect(first?.aggregateId).toBe(first?.eventId);
  });

  it("refuses to enqueue a payload that could not be applied", async () => {
    const db = makeDb();
    const { service, tx } = await build(db);

    await expect(
      service.emit(tx, { type: "new_subscription", orgId: "", mrr: 1 }),
    ).rejects.toThrow(ZodError);
    expect(db._store.outbox).toHaveLength(0);
  });
});

describe("the consumer applies each event exactly once", () => {
  const payload = { type: "new_subscription", orgId: "org1", plan: "STARTER", mrr: 99_900, amount: 99_900 };

  it("writes the revenue row and marks the event complete", async () => {
    const db = makeDb();
    const { service } = await build(db);

    await service.handle(makeEvent(payload));

    expect(db._store.revenue).toHaveLength(1);
    expect(db._store.revenue[0]).toMatchObject({ type: "new_subscription", orgId: "org1", mrr: 99_900 });
    expect(db._store.inboxOutcomes.at(-1)).toMatchObject({ status: "COMPLETED" });
  });

  it("writes the row and the fence in one transaction", async () => {
    const db = makeDb();
    const { service } = await build(db);

    await service.handle(makeEvent(payload));

    expect(db._store.transactions).toBe(1);
  });

  it("writes nothing when the inbox says the event was already applied", async () => {
    const db = makeDb({ claimable: false });
    const { service } = await build(db);

    await service.handle(makeEvent(payload));

    expect(db._store.revenue).toHaveLength(0);
  });

  it("fails the event rather than writing an unparseable payload", async () => {
    const db = makeDb();
    const { service } = await build(db);

    await service.handle(makeEvent({ type: "not-a-revenue-type", orgId: "org1", mrr: 1 }));

    expect(db._store.revenue).toHaveLength(0);
    expect(db._store.inboxOutcomes.at(-1)).toMatchObject({ status: "FAILED" });
  });

  it("rethrows a write failure so the outbox retries and eventually dead-letters it", async () => {
    const db = makeDb({ revenueInsertRejects: new Error("connection reset") });
    const { service } = await build(db);

    await expect(service.handle(makeEvent(payload))).rejects.toThrow("connection reset");
  });
});

describe("reported figures reconcile with subscription state", () => {
  const subscriptionRows = [
    { status: "ACTIVE", plan: "STARTER", count: 2 },
    { status: "ACTIVE", plan: "PROFESSIONAL", count: 1 },
    { status: "TRIAL", plan: "STARTER", count: 4 },
    { status: "CANCELLED", plan: "ENTERPRISE", count: 3 },
  ];

  it("takes MRR from what is subscribed now, not from the event stream", async () => {
    const db = makeDb({
      subscriptionRows,
      movementRows: [{ type: "new_subscription", mrr: 9_999_999, count: 40, recentMrr: 0 }],
    });
    const { service } = await build(db);

    const metrics = await service.getMetrics("org1");

    expect(metrics.mrr).toBe(PLAN_PRICES_PAISE.STARTER * 2 + PLAN_PRICES_PAISE.PROFESSIONAL);
    expect(metrics.activeSubscriptions).toBe(3);
    expect(metrics.trialSubscriptions).toBe(4);
  });

  it("excludes cancelled subscriptions from the level", async () => {
    const db = makeDb({ subscriptionRows });
    const { service } = await build(db);

    const metrics = await service.getMetrics("org1");

    expect(metrics.mrr).toBe(PLAN_PRICES_PAISE.STARTER * 2 + PLAN_PRICES_PAISE.PROFESSIONAL);
    expect(metrics.mrr).toBeLessThan(PLAN_PRICES_PAISE.ENTERPRISE * 3);
  });

  it("reconciles the reported level against the subscriptions behind it", async () => {
    const db = makeDb({ subscriptionRows });
    const { service } = await build(db);

    await expect(service.reconcile("org1")).resolves.toEqual({
      reportedMrr: PLAN_PRICES_PAISE.STARTER * 2 + PLAN_PRICES_PAISE.PROFESSIONAL,
      subscriptionMrr: PLAN_PRICES_PAISE.STARTER * 2 + PLAN_PRICES_PAISE.PROFESSIONAL,
      reconciles: true,
    });
  });

  it("reports zero rather than dividing by nothing when there are no subscriptions", async () => {
    const { service } = await build(makeDb({ subscriptionRows: [], movementRows: [] }));

    await expect(service.getMetrics("org1")).resolves.toMatchObject({ mrr: 0, arpu: 0, churnRate: 0 });
  });

  it("keeps subscription and movement aggregates inside the requested organization", async () => {
    const db = makeDb({
      allowedOrgId: "org-a",
      subscriptionRows: [
        { orgId: "org-a", status: "ACTIVE", plan: "STARTER", count: 1 },
        { orgId: "org-b", status: "ACTIVE", plan: "ENTERPRISE", count: 9 },
      ],
      movementRows: [
        { orgId: "org-a", type: "new_subscription", mrr: 100, count: 1, recentMrr: 100 },
        { orgId: "org-b", type: "new_subscription", mrr: 900, count: 9, recentMrr: 900 },
      ],
    });
    const { service } = await build(db);

    await expect(service.getMetrics("org-a")).resolves.toMatchObject({
      mrr: PLAN_PRICES_PAISE.STARTER,
      activeSubscriptions: 1,
    });
  });
});
