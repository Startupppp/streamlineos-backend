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
import { BillingService } from "../billing/core/billing.service";
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
  dedupeKey?: string;
}

function makeDb(seed: {
  expired?: Array<{ id: number; plan: string }>;
  pastDue?: Array<Record<string, unknown>>;
  // Rows the conditional PAST_DUE -> CANCELLED update actually flipped. Unseeded means the
  // uncontended case, where the sweep wins the race and one row changes.
  suspended?: Array<{ id: number }>;
  owner?: { userId: string } | null;
}) {
  const store = { updates: [] as Array<Record<string, unknown>>, order: [] as string[] };

  const updateChain = (values: Record<string, unknown>) => ({
    where: () => {
      store.order.push("update-subscription");
      store.updates.push(values);
      const rows: Array<{ id: number; plan?: string }> =
        values.status === "CANCELLED" ? (seed.suspended ?? [{ id: 7 }]) : (seed.expired ?? []);
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
  const planLimits = { bust: jest.fn() };
  const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };
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
        { provide: BillingService, useValue: { redriveStuckProviderEvents: jest.fn().mockResolvedValue({ attempted: 0, recovered: 0, failed: 0 }) } },
      { provide: EmailService, useValue: { sendEmail: jest.fn() } },
      { provide: AiCreditsService, useValue: { getWallet: jest.fn(), purchaseCreditsDirectly: jest.fn() } },
      { provide: PlanLimitsService, useValue: planLimits },
      { provide: RevenueAnalyticsService, useValue: revenue },
      { provide: NotificationDispatchService, useValue: dispatch },
    ],
  }).compile();
  return { service: module.get(CronBillingService), emitted, revenue, planLimits, dispatch };
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

/**
 * The suspension used to discard the UPDATE's result and emit unconditionally. The UPDATE is
 * conditional on `status = 'PAST_DUE'`, so a second sweep racing the first flipped nothing at all
 * and still emitted a second `churn` carrying the plan's full MRR — the same lost customer counted
 * twice, plus a second cache bust and a second CRITICAL notification to the owner.
 */
describe("c17-05 — only the sweep that actually cancelled the subscription reports the churn", () => {
  const suspendable = [
    {
      id: 7,
      orgId: "org1",
      plan: "PROFESSIONAL",
      metadata: { pastDueAt: new Date(Date.now() - 30 * 86_400_000).toISOString() },
      updatedAt: new Date(Date.now() - 30 * 86_400_000),
    },
  ];

  it("emits no churn when the conditional cancel flipped no row", async () => {
    const db = makeDb({ expired: [], pastDue: suspendable, suspended: [], owner: { userId: "user1" } });
    const { service, emitted } = await build(db);

    const result = await service.processDunning();

    expect(emitted).toHaveLength(0);
    expect(result.suspended).toBe(0);
  });

  it("busts no cache and notifies nobody when it lost the race", async () => {
    const db = makeDb({ expired: [], pastDue: suspendable, suspended: [], owner: { userId: "user1" } });
    const { service, planLimits, dispatch } = await build(db);

    await service.processDunning();

    expect(planLimits.bust).not.toHaveBeenCalled();
    expect(dispatch.emit).not.toHaveBeenCalled();
  });

  it("counts the losing sweep as skipped rather than as a suspension", async () => {
    const db = makeDb({ expired: [], pastDue: suspendable, suspended: [], owner: { userId: "user1" } });
    const { service } = await build(db);

    const result = await service.processDunning();

    expect(result).toMatchObject({ suspended: 0, skipped: 1 });
  });

  it("carries a dedupeKey naming the suspension, so a re-run collapses onto one revenue row", async () => {
    const db = makeDb({ expired: [], pastDue: suspendable, owner: { userId: "user1" } });
    const { service, emitted } = await build(db);

    await service.processDunning();

    expect(emitted[0]?.dedupeKey).toBe("dunning-suspension:7");
  });

  it("still suspends, busts and notifies when it won the race", async () => {
    const db = makeDb({ expired: [], pastDue: suspendable, suspended: [{ id: 7 }], owner: { userId: "user1" } });
    const { service, emitted, planLimits, dispatch } = await build(db);

    const result = await service.processDunning();

    expect(result).toMatchObject({ suspended: 1, skipped: 0 });
    expect(emitted).toHaveLength(1);
    expect(planLimits.bust).toHaveBeenCalledWith("org1");
    expect(dispatch.emit).toHaveBeenCalledTimes(1);
  });
});
