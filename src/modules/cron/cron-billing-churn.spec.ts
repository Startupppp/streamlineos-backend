import { Test } from "@nestjs/testing";

jest.mock("../../common/tenant", () => ({
  forEachOrg: async (
    _db: unknown,
    _name: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn((globalThis as { __cronTx?: unknown }).__cronTx, "org1");
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
}));

import { DRIZZLE } from "../../db/drizzle.constants";
import { subscriptions } from "../../db/schema";
import { CronBillingService } from "./cron-billing.service";
import { EmailService } from "../email/email.service";
import { AiCreditsService } from "../billing/core/ai-credits.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { RevenueAnalyticsService } from "../billing/core/revenue-analytics.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { PLAN_PRICES_PAISE } from "../billing/core/plan-entitlements.constants";

interface EmittedEvent {
  type: string;
  orgId: string;
  plan?: string;
  mrr: number;
  metadata?: Record<string, unknown>;
}

function makeDb(seed: {
  expired?: Array<{ id: number; plan: string }>;
  pastDue?: Array<Record<string, unknown>>;
  owner?: { userId: string } | null;
}) {
  const store = { updates: [] as Array<Record<string, unknown>>, order: [] as string[] };

  const updateChain = (values: Record<string, unknown>) => ({
    where: () => {
      store.order.push("update-subscription");
      store.updates.push(values);
      const rows = seed.expired ?? [];
      return {
        returning: () => Promise.resolve(rows),
        then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
      };
    },
  });

  const surface = {
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) =>
        table === subscriptions ? updateChain(values) : { where: () => Promise.resolve([]) },
    }),
    select: () => ({
      from: (table: unknown) => {
        const owners = seed.owner ? [{ ...seed.owner, email: "owner@example.com", orgName: "Org" }] : [];
        const joined: {
          innerJoin: () => typeof joined;
          where: () => typeof joined;
          limit: () => Promise<typeof owners>;
          then: (resolve: (value: typeof owners) => unknown) => Promise<unknown>;
        } = {
          innerJoin: () => joined,
          where: () => joined,
          limit: () => Promise.resolve(owners),
          then: (resolve) => Promise.resolve(owners).then(resolve),
        };
        return {
          innerJoin: () => joined,
          where: () => Promise.resolve(table === subscriptions ? (seed.pastDue ?? []) : []),
          limit: () => Promise.resolve([]),
        };
      },
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }),
        returning: () => Promise.resolve([]),
        then: (resolve: (value: never[]) => unknown) => Promise.resolve([]).then(resolve),
      }),
    }),
    execute: jest.fn().mockResolvedValue([]),
    query: {
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(seed.owner ?? null) },
    },
    _store: store,
  };

  (globalThis as { __cronTx?: unknown }).__cronTx = surface;
  return surface;
}

async function build(db: ReturnType<typeof makeDb>) {
  const emitted: EmittedEvent[] = [];
  const revenue = {
    emit: jest.fn().mockImplementation(async (_tx: unknown, event: EmittedEvent) => {
      db._store.order.push("emit-churn");
      emitted.push(event);
    }),
  };
  const module = await Test.createTestingModule({
    providers: [
      CronBillingService,
      { provide: DRIZZLE, useValue: db },
      { provide: EmailService, useValue: { send: jest.fn(), sendTemplate: jest.fn() } },
      { provide: AiCreditsService, useValue: { getBalance: jest.fn(), purchaseCreditsDirectly: jest.fn() } },
      { provide: PlanLimitsService, useValue: { bust: jest.fn() } },
      { provide: RevenueAnalyticsService, useValue: revenue },
      { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
    ],
  }).compile();
  return { service: module.get(CronBillingService), emitted, revenue };
}

describe("c17-05 — a trial that lapses records churn", () => {
  it("emits one churn event per expired trial, inside the sweep's transaction", async () => {
    const db = makeDb({ expired: [{ id: 1, plan: "STARTER" }, { id: 2, plan: "PROFESSIONAL" }] });
    const { service, emitted } = await build(db);

    await service.processTrialExpiry();

    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      type: "churn",
      orgId: "org1",
      plan: "STARTER",
      metadata: { subscriptionId: 1, source: "trial-expiry" },
    });
  });

  it("records no lost MRR, because a trial never contributed any", async () => {
    const db = makeDb({ expired: [{ id: 1, plan: "ENTERPRISE" }] });
    const { service, emitted } = await build(db);

    await service.processTrialExpiry();

    expect(emitted[0]?.mrr).toBe(0);
  });

  it("emits after the status change, so the event cannot exist without it", async () => {
    const db = makeDb({ expired: [{ id: 1, plan: "STARTER" }] });
    const { service } = await build(db);

    await service.processTrialExpiry();

    expect(db._store.order.indexOf("update-subscription")).toBeLessThan(
      db._store.order.indexOf("emit-churn"),
    );
  });

  it("emits nothing when no trial expired", async () => {
    const db = makeDb({ expired: [] });
    const { service, emitted } = await build(db);

    await service.processTrialExpiry();

    expect(emitted).toHaveLength(0);
  });
});

describe("c17-05 — a subscription suspended for non-payment records churn", () => {
  const suspendable = [
    {
      id: 7,
      orgId: "org1",
      plan: "PROFESSIONAL",
      metadata: { pastDueAt: new Date(Date.now() - 30 * 86_400_000).toISOString() },
      updatedAt: new Date(Date.now() - 30 * 86_400_000),
    },
  ];

  it("emits churn carrying the MRR the cancelled plan was worth", async () => {
    const db = makeDb({ expired: [], pastDue: suspendable, owner: { userId: "user1" } });
    const { service, emitted } = await build(db);

    await service.processDunning();

    const churn = emitted.filter((event) => event.type === "churn");
    expect(churn).toHaveLength(1);
    expect(churn[0]).toMatchObject({
      orgId: "org1",
      plan: "PROFESSIONAL",
      mrr: PLAN_PRICES_PAISE.PROFESSIONAL,
      metadata: { subscriptionId: 7, source: "dunning-suspension" },
    });
  });

  it("emits nothing for a subscription that is not yet due for suspension", async () => {
    const recent = [{ ...suspendable[0], metadata: { pastDueAt: new Date().toISOString() }, updatedAt: new Date() }];
    const db = makeDb({ expired: [], pastDue: recent, owner: { userId: "user1" } });
    const { service, emitted } = await build(db);

    await service.processDunning();

    expect(emitted.filter((event) => event.type === "churn")).toHaveLength(0);
  });

  it("emits nothing for a subscription already suspended", async () => {
    const already = [{ ...suspendable[0], metadata: { ...suspendable[0].metadata, suspendedForNonPayment: true } }];
    const db = makeDb({ expired: [], pastDue: already, owner: { userId: "user1" } });
    const { service, emitted } = await build(db);

    await service.processDunning();

    expect(emitted).toHaveLength(0);
  });

  it("emits exactly one churn per lost customer — the PAST_DUE transition emits none", async () => {
    const db = makeDb({ expired: [], pastDue: suspendable, owner: { userId: "user1" } });
    const { service, emitted } = await build(db);

    await service.processDunning();

    expect(emitted).toHaveLength(1);
  });
});
