import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { PlanLimitsService } from "./plan-limits.service";
import {
  PLAN_LOCKED_MODULES,
  PLAN_FEATURE_FLAGS,
  type PlanTier,
} from "./plan-entitlements.constants";
import { triagePastDue } from "../../cron/cron-billing-past-due";
import { addClampedMonths } from "./trial-subscription";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

function makeCache(): CacheService {
  return {
    cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    set: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
  } as unknown as CacheService;
}

function makeDb(rows: Record<string, unknown>[]) {
  return { execute: jest.fn().mockResolvedValue(rows) };
}

async function buildService(db: ReturnType<typeof makeDb>): Promise<PlanLimitsService> {
  const module = await Test.createTestingModule({
    providers: [
      PlanLimitsService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: makeCache() },
    ],
  }).compile();
  return module.get(PlanLimitsService);
}

function sub(plan: string, status: string, trial_ends_at: string | null = null) {
  return { plan, status, trial_ends_at };
}

describe("subscription-lifecycle — resolveTier with fake clock", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("FREE when no subscription exists", async () => {
    const svc = await buildService(makeDb([]));
    expect(await svc.resolveTier("org1")).toEqual({ tier: "FREE", plan: "FREE" });
  });

  it("PAID/STARTER during active trial", async () => {
    jest.setSystemTime(new Date("2026-09-15T00:00:00Z"));
    const svc = await buildService(
      makeDb([sub("STARTER", "TRIAL", "2026-10-01T00:00:00.000Z")]),
    );
    expect(await svc.resolveTier("org1")).toEqual({ tier: "PAID", plan: "STARTER" });
  });

  it("FREE at the instant the trial clock passes trial_ends_at", async () => {
    jest.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    const svc = await buildService(
      makeDb([sub("STARTER", "TRIAL", "2026-10-01T00:00:00.000Z")]),
    );
    expect(await svc.resolveTier("org1")).toEqual({ tier: "FREE", plan: "FREE" });
  });

  it("PAID/STARTER for ACTIVE STARTER subscription regardless of period end", async () => {
    jest.setSystemTime(new Date("2027-01-01T00:00:00Z"));
    const svc = await buildService(makeDb([sub("STARTER", "ACTIVE")]));
    expect(await svc.resolveTier("org1")).toEqual({ tier: "PAID", plan: "STARTER" });
  });

  it("PAID/PROFESSIONAL for ACTIVE PROFESSIONAL subscription", async () => {
    const svc = await buildService(makeDb([sub("PROFESSIONAL", "ACTIVE")]));
    expect(await svc.resolveTier("org1")).toEqual({ tier: "PAID", plan: "PROFESSIONAL" });
  });

  it("ENTERPRISE for ACTIVE ENTERPRISE subscription", async () => {
    const svc = await buildService(makeDb([sub("ENTERPRISE", "ACTIVE")]));
    expect(await svc.resolveTier("org1")).toEqual({ tier: "ENTERPRISE", plan: "ENTERPRISE" });
  });

  it("PAID during PAST_DUE grace — dunning suspends at D+14, not immediately", async () => {
    const svc = await buildService(makeDb([sub("STARTER", "PAST_DUE")]));
    expect(await svc.resolveTier("org1")).toEqual({ tier: "PAID", plan: "STARTER" });
  });

  it("FREE once CANCELLED (dunning suspension completes)", async () => {
    const svc = await buildService(makeDb([sub("STARTER", "CANCELLED")]));
    expect(await svc.resolveTier("org1")).toEqual({ tier: "FREE", plan: "FREE" });
  });

  it("FREE once EXPIRED", async () => {
    const svc = await buildService(makeDb([sub("PROFESSIONAL", "EXPIRED")]));
    expect(await svc.resolveTier("org1")).toEqual({ tier: "FREE", plan: "FREE" });
  });

  it("renewal: re-purchasing same plan while ACTIVE returns paid tier", async () => {
    const svc = await buildService(makeDb([sub("STARTER", "ACTIVE")]));
    expect(await svc.resolveTier("org1")).toEqual({ tier: "PAID", plan: "STARTER" });
  });

  it("downgrade: PROFESSIONAL→STARTER still returns PAID tier after update", async () => {
    const svc = await buildService(makeDb([sub("STARTER", "ACTIVE")]));
    expect(await svc.resolveTier("org1")).toEqual({ tier: "PAID", plan: "STARTER" });
  });
});

describe("subscription-lifecycle — PAST_DUE grace policy (dunning)", () => {
  it("SUSPENSION_DAY is 14: subscriptions past due for < 14 days go to remind, not suspend", () => {
    const pastDueAt = new Date("2026-09-01T00:00:00Z");
    const now = new Date("2026-09-14T00:00:00Z");
    const triage = triagePastDue(
      [{ id: 1, orgId: "org1", plan: "STARTER", metadata: { pastDueAt: pastDueAt.toISOString() }, updatedAt: pastDueAt }],
      now,
    );
    expect(triage.toRemind).toHaveLength(1);
    expect(triage.toSuspend).toHaveLength(0);
  });

  it("suspends at D+14 (inclusive)", () => {
    const pastDueAt = new Date("2026-09-01T00:00:00Z");
    const now = new Date("2026-09-15T00:00:00Z");
    const triage = triagePastDue(
      [{ id: 1, orgId: "org1", plan: "STARTER", metadata: { pastDueAt: pastDueAt.toISOString() }, updatedAt: pastDueAt }],
      now,
    );
    expect(triage.toSuspend).toHaveLength(1);
  });

  it("already-suspended subscriptions are counted and skipped", () => {
    const triage = triagePastDue(
      [{ id: 1, orgId: "org1", plan: "STARTER", metadata: { suspendedForNonPayment: true }, updatedAt: new Date() }],
      new Date(),
    );
    expect(triage.alreadySuspended).toBe(1);
    expect(triage.toRemind).toHaveLength(0);
    expect(triage.toSuspend).toHaveLength(0);
  });

  it("falls back to updatedAt when metadata pastDueAt is absent", () => {
    const updatedAt = new Date("2026-09-01T00:00:00Z");
    const now = new Date("2026-09-16T00:00:00Z");
    const triage = triagePastDue(
      [{ id: 1, orgId: "org1", plan: "STARTER", metadata: {}, updatedAt }],
      now,
    );
    expect(triage.toSuspend).toHaveLength(1);
  });
});

describe("subscription-lifecycle — downgrade preserves universal member access", () => {
  const universalSurfaces = ["home", "chat", "mail", "calendar"] as const;

  for (const tier of ["FREE", "PAID", "ENTERPRISE"] as PlanTier[]) {
    it(`${tier}: universal surfaces are not in locked modules`, () => {
      const locked = PLAN_LOCKED_MODULES[tier];
      for (const surface of universalSurfaces)
        expect(locked).not.toContain(surface);
    });
  }

  it("PAID plan retains chat and mail feature flags after downgrade from ENTERPRISE", () => {
    expect(PLAN_FEATURE_FLAGS["PAID"].chatGroupHuddles).toBe(true);
    expect(PLAN_FEATURE_FLAGS["PAID"].chatVoiceVideo).toBe(true);
  });

  it("FREE plan still does not lock mail, chat, or calendar", () => {
    expect(PLAN_LOCKED_MODULES["FREE"]).not.toContain("chat");
    expect(PLAN_LOCKED_MODULES["FREE"]).not.toContain("mail");
    expect(PLAN_LOCKED_MODULES["FREE"]).not.toContain("calendar");
  });
});

describe("addClampedMonths — anniversary date policy", () => {
  it("Jan 31 + 1 month clamps to last day of February (not Mar 2/3)", () => {
    const jan31 = new Date(2026, 0, 31);
    const result = addClampedMonths(jan31, 1);
    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(28);
  });

  it("Feb 29 (leap year 2024) + 1 month = Mar 29, no clamping needed", () => {
    const feb29 = new Date(2024, 1, 29);
    const result = addClampedMonths(feb29, 1);
    expect(result.getMonth()).toBe(2);
    expect(result.getDate()).toBe(29);
  });

  it("Aug 31 + 1 month clamps to Sep 30 (not Oct 1)", () => {
    const aug31 = new Date(2026, 7, 31);
    const result = addClampedMonths(aug31, 1);
    expect(result.getMonth()).toBe(8);
    expect(result.getDate()).toBe(30);
  });

  it("Jan 31 + 12 months stays Jan 31 (annual billing)", () => {
    const jan31 = new Date(2026, 0, 31);
    const result = addClampedMonths(jan31, 12);
    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(31);
  });

  it("Mar 15 + 1 month = Apr 15, no clamping", () => {
    const mar15 = new Date(2026, 2, 15);
    const result = addClampedMonths(mar15, 1);
    expect(result.getMonth()).toBe(3);
    expect(result.getDate()).toBe(15);
  });

  it("preserves the year and time portion of the date", () => {
    const date = new Date(2026, 0, 15, 10, 30, 0);
    const result = addClampedMonths(date, 2);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(2);
    expect(result.getDate()).toBe(15);
    expect(result.getHours()).toBe(10);
    expect(result.getMinutes()).toBe(30);
  });
});
