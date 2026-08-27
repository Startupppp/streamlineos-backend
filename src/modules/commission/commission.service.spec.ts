jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db),
  runInNewTenantTransaction: <T>(db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) =>
    fn(db),
}));

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { CommissionRuleSet } from "../../db/schema/crm/commission";
import { CommissionService, clampToInt4, earningsUserFilter } from "./commission.service";

/**
 * The properties that make a payout reproducible, checked where they live.
 *
 * The arithmetic is covered by `commission-rules.spec.ts`; this file is about
 * the plumbing around it — which date selects the rules, what happens to a
 * version once it has paid somebody, and what a retried calculation does. Each
 * of those has a way of being wrong that produces no error at all.
 */

/**
 * A thenable Drizzle chain that yields the next queued result.
 *
 * Builder methods return the chain, and `await`ing it at any point resolves the
 * next queue entry — which is what lets one helper stand in for both the
 * `.limit(1)`-terminated reads and the ones awaited straight off `.where()`.
 */
function makeSelect(queue: unknown[][]) {
  const chain: Record<string, unknown> = {};
  for (const method of [
    "from",
    "where",
    "orderBy",
    "limit",
    "offset",
    "innerJoin",
    "leftJoin",
    "groupBy",
  ])
    chain[method] = jest.fn(() => chain);
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(queue.shift() ?? []).then(resolve, reject);
  return chain;
}

const ORG = "org-1";
const USER = "user-1";

const RULES: CommissionRuleSet = {
  basis: "deal_value",
  period: "MONTH",
  quotaMinor: 1_000_000,
  tiers: [
    { from: 0, rateBps: 500 },
    { from: 10_000, rateBps: 1_000 },
  ],
  accelerators: [],
  capMinor: null,
};

interface Harness {
  service: CommissionService;
  selectQueue: unknown[][];
  insertValues: jest.Mock;
  insertReturning: jest.Mock;
  updateSet: jest.Mock;
  updateReturning: jest.Mock;
}

async function harness(): Promise<Harness> {
  const selectQueue: unknown[][] = [];

  const insertReturning = jest.fn().mockResolvedValue([]);
  const insertValues = jest.fn();
  const insertChain: Record<string, unknown> = {
    values: insertValues,
    onConflictDoNothing: jest.fn(() => insertChain),
    onConflictDoUpdate: jest.fn(() => insertChain),
    returning: insertReturning,
  };
  insertValues.mockImplementation(() => insertChain);

  const updateReturning = jest.fn().mockResolvedValue([]);
  const updateSet = jest.fn();
  const updateChain: Record<string, unknown> = {
    set: updateSet,
    where: jest.fn(() => updateChain),
    returning: updateReturning,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
  };
  updateSet.mockImplementation(() => updateChain);

  /**
   * `delete(...).where(...)`, awaitable.
   *
   * `calculateForDeal` now writes the accrual decomposition in the same
   * transaction as the earning, and that begins by clearing any parts already
   * filed against it. A bare `jest.fn()` here returns undefined and the chained
   * `.where()` throws — which would look like a bug in the calculation rather
   * than a gap in the double.
   */
  const deleteChain: Record<string, unknown> = {
    where: jest.fn(() => deleteChain),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
  };

  const db = {
    select: jest.fn(() => makeSelect(selectQueue)),
    insert: jest.fn(() => insertChain),
    update: jest.fn(() => updateChain),
    delete: jest.fn(() => deleteChain),
  };

  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [CommissionService, { provide: DRIZZLE, useValue: db }],
  }).compile();

  return {
    service: moduleRef.get(CommissionService),
    selectQueue,
    insertValues,
    insertReturning,
    updateSet,
    updateReturning,
  };
}

/** The reads `calculateForDeal` performs, in the order it performs them. */
function queueForCalculation(
  h: Harness,
  overrides: {
    deal?: Record<string, unknown>;
    wonStages?: unknown[];
    assignment?: Record<string, unknown> | null;
    version?: Record<string, unknown> | null;
    priorTotal?: string;
  } = {},
): void {
  h.selectQueue.push(
    overrides.deal === undefined
      ? [
          {
            id: 7,
            stage: "WON",
            valueMinor: 2_000_000,
            actualCloseDate: "2026-03-31",
            assignedToId: USER,
          },
        ]
      : [overrides.deal],
    overrides.wonStages ?? [{ key: "WON" }],
    overrides.assignment === null
      ? []
      : [overrides.assignment ?? { planId: "plan-1", quotaOverrideMinor: null }],
    overrides.version === null
      ? []
      : [
          overrides.version ?? {
            planVersionId: "version-1",
            versionNumber: 1,
            effectiveFrom: "2026-01-01",
            rules: RULES,
          },
        ],
    [{ currency: "INR" }],
    [{ total: overrides.priorTotal ?? "0" }],
  );
}

describe("calculateForDeal prices from the close date, never from today", () => {
  afterEach(() => jest.useRealTimers());

  /**
   * The whole ticket in one assertion. The clock is set two years past the
   * deal's close, and every dated output still comes from the deal: the version
   * cited, the earning date, and the attainment window. An implementation that
   * reached for `new Date()` anywhere on this path would file a 2026 deal
   * against a 2028 period and cite whichever version happened to be current.
   */
  it("uses the deal's close date for the version, the period and the earning", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2028-09-01T10:00:00Z"));
    const h = await harness();
    queueForCalculation(h);
    h.insertReturning.mockResolvedValueOnce([{ earningId: "earning-1" }]);

    const result = await h.service.calculateForDeal(ORG, { dealId: 7 });

    expect(result.created).toBe(true);
    const written = h.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(written).toMatchObject({
      planVersionId: "version-1",
      earnedOn: "2026-03-31",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      sourceType: "deal",
      sourceId: "7",
    });
  });

  it("carries the period's prior attainment into the bands", async () => {
    const h = await harness();
    // Quota already met this month, so the whole deal sits in the upper band.
    queueForCalculation(h, { priorTotal: "1000000" });
    h.insertReturning.mockResolvedValueOnce([{ earningId: "earning-1" }]);

    await h.service.calculateForDeal(ORG, { dealId: 7 });

    const written = h.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.priorBasisMinor).toBe(1_000_000);
    // 2,000,000 entirely at 10%, rather than 150,000 restarting at the entry band.
    expect(written.amountMinor).toBe(200_000);
    expect(written.attainmentBps).toBe(30_000);
  });

  it("stores the derivation, so a dispute is answered by reading the row", async () => {
    const h = await harness();
    queueForCalculation(h);
    h.insertReturning.mockResolvedValueOnce([{ earningId: "earning-1" }]);

    await h.service.calculateForDeal(ORG, { dealId: 7 });

    const written = h.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    const computation = written.computation as Record<string, unknown>;
    expect(computation.rules).toEqual(RULES);
    expect(computation.planVersionNumber).toBe(1);
    expect(computation.versionEffectiveFrom).toBe("2026-01-01");
    expect(Array.isArray(computation.slices)).toBe(true);
  });

  /**
   * Sealing is what turns "we version plans" into "history cannot move". If the
   * seal is skipped, every later edit to this version silently rewrites what
   * this earning means.
   */
  it("seals the version it priced from", async () => {
    const h = await harness();
    queueForCalculation(h);
    h.insertReturning.mockResolvedValueOnce([{ earningId: "earning-1" }]);

    await h.service.calculateForDeal(ORG, { dealId: 7 });

    expect(h.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ sealedAt: expect.any(Date) }),
    );
  });

  /**
   * The unique index on (org, source, user) makes the second INSERT a no-op.
   * The read-back is what lets the caller tell "already calculated" from
   * "failed", and the absence of a seal write is what says nothing was paid.
   */
  it("returns the existing earning on a repeat rather than paying twice", async () => {
    const h = await harness();
    queueForCalculation(h);
    h.insertReturning.mockResolvedValueOnce([]); // conflict: row already there
    h.selectQueue.push([{ earningId: "earning-1", amountMinor: 150_000 }]);

    const result = await h.service.calculateForDeal(ORG, { dealId: 7 });

    expect(result).toEqual({
      earning: { earningId: "earning-1", amountMinor: 150_000 },
      created: false,
    });
    expect(h.updateSet).not.toHaveBeenCalled();
  });
});

describe("calculateForDeal refuses rather than guessing", () => {
  it("refuses a deal that is not in one of the tenant's won stages", async () => {
    const h = await harness();
    queueForCalculation(h, {
      deal: {
        id: 7,
        stage: "NEGOTIATION",
        valueMinor: 2_000_000,
        actualCloseDate: "2026-03-31",
        assignedToId: USER,
      },
    });

    await expect(h.service.calculateForDeal(ORG, { dealId: 7 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  /**
   * Falling back to today would make the same deal compute differently
   * depending on when somebody pressed the button, which is the one thing a
   * reproducible payout cannot do.
   */
  it("refuses a deal with no close date instead of pricing it as of today", async () => {
    const h = await harness();
    queueForCalculation(h, {
      deal: {
        id: 7,
        stage: "WON",
        valueMinor: 2_000_000,
        actualCloseDate: null,
        assignedToId: USER,
      },
    });

    await expect(h.service.calculateForDeal(ORG, { dealId: 7 })).rejects.toThrow(
      /no actual close date/,
    );
  });

  it("refuses when the owner was on no plan on that date", async () => {
    const h = await harness();
    queueForCalculation(h, { assignment: null });

    await expect(h.service.calculateForDeal(ORG, { dealId: 7 })).rejects.toThrow(
      /on no commission plan/,
    );
  });

  it("refuses when no version of the plan was in force on that date", async () => {
    const h = await harness();
    queueForCalculation(h, { version: null });

    await expect(h.service.calculateForDeal(ORG, { dealId: 7 })).rejects.toThrow(
      /in force on 2026-03-31/,
    );
  });
});

describe("a version that has been earned against is history", () => {
  /**
   * The service's UPDATE carries `sealed_at IS NULL`, so a sealed version
   * matches nothing and the empty result is the refusal. Reported as 409 rather
   * than 404 because the version plainly exists — telling an administrator it
   * is missing would send them to create a duplicate.
   */
  it("refuses to edit a sealed version, and says why", async () => {
    const h = await harness();
    h.updateReturning.mockResolvedValueOnce([]);
    h.selectQueue.push([{ sealedAt: new Date("2026-04-01T00:00:00Z") }]);

    await expect(
      h.service.updateVersion(ORG, "plan-1", "version-1", { rules: RULES }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("still reports a genuinely missing version as missing", async () => {
    const h = await harness();
    h.updateReturning.mockResolvedValueOnce([]);
    h.selectQueue.push([]);

    await expect(
      h.service.updateVersion(ORG, "plan-1", "nope", { rules: RULES }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("allows an edit while the version has paid nobody", async () => {
    const h = await harness();
    h.updateReturning.mockResolvedValueOnce([{ planVersionId: "version-1" }]);

    await expect(
      h.service.updateVersion(ORG, "plan-1", "version-1", { rules: RULES }),
    ).resolves.toEqual({ planVersionId: "version-1" });
  });

  /**
   * Backdating is the other way to restate history: it moves which version is
   * in force for dates that already have earnings filed against a different
   * one, so the ledger and a fresh resolution of the same date disagree.
   */
  it("refuses a new version that would take effect on or before the current one", async () => {
    const h = await harness();
    h.selectQueue.push(
      [{ planId: "plan-1", retiredOn: null }],
      [{ versionNumber: 2, effectiveFrom: "2026-04-01" }],
    );

    await expect(
      h.service.createVersion(ORG, "plan-1", USER, {
        effectiveFrom: "2026-02-01",
        rules: RULES,
      }),
    ).rejects.toThrow(/backdating/);
  });

  it("numbers a new version after the newest one", async () => {
    const h = await harness();
    h.selectQueue.push(
      [{ planId: "plan-1", retiredOn: null }],
      [{ versionNumber: 2, effectiveFrom: "2026-04-01" }],
    );
    h.insertReturning.mockResolvedValueOnce([{ planVersionId: "version-3" }]);

    await h.service.createVersion(ORG, "plan-1", USER, {
      effectiveFrom: "2026-07-01",
      rules: RULES,
    });

    expect(h.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ versionNumber: 3, effectiveFrom: "2026-07-01" }),
    );
  });

  it("refuses a new version on a retired plan", async () => {
    const h = await harness();
    h.selectQueue.push([{ planId: "plan-1", retiredOn: "2026-06-30" }]);

    await expect(
      h.service.createVersion(ORG, "plan-1", USER, {
        effectiveFrom: "2026-07-01",
        rules: RULES,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("clampToInt4", () => {
  /**
   * A plan with an absurdly small quota produces an attainment past 2^31, and
   * `attainment_bps` is int4 — so without this the INSERT fails with 22003 and
   * the commission is not recorded at all, because a display column overflowed.
   */
  it("saturates rather than letting a reporting column fail the write", async () => {
    const h = await harness();
    queueForCalculation(h, {
      version: {
        planVersionId: "version-1",
        versionNumber: 1,
        effectiveFrom: "2026-01-01",
        rules: { ...RULES, quotaMinor: 1 },
      },
    });
    h.insertReturning.mockResolvedValueOnce([{ earningId: "earning-1" }]);

    await h.service.calculateForDeal(ORG, { dealId: 7 });

    const written = h.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.attainmentBps).toBe(2_147_483_647);
    // The money is untouched by the saturation.
    expect(written.amountMinor).toBe(200_000);
  });

  it("leaves an ordinary figure alone", () => {
    expect(clampToInt4(12_345)).toBe(12_345);
    expect(clampToInt4(-12_345)).toBe(-12_345);
  });
});

describe("earningsUserFilter", () => {
  it("pins a narrow-scoped caller to their own rows whatever they asked for", () => {
    expect(
      earningsUserFilter({ userId: "somebody-else" }, { userId: USER, viewAll: false }),
    ).toBe(USER);
  });

  it("lets a full-scope caller ask for one person", () => {
    expect(
      earningsUserFilter({ userId: "somebody-else" }, { userId: USER, viewAll: true }),
    ).toBe("somebody-else");
  });

  it("opens the ledger only when the caller may see everybody and asked to", () => {
    expect(earningsUserFilter({}, { userId: USER, viewAll: true })).toBeNull();
    expect(earningsUserFilter({}, { userId: USER, viewAll: false })).toBe(USER);
  });
});
