jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db),
  runInNewTenantTransaction: <T>(
    db: unknown,
    _orgId: string,
    fn: (tx: unknown) => Promise<T>,
  ) => fn(db),
}));

import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CommissionAccrualService } from "./commission-accrual.service";

/**
 * The failure this file exists to prevent: a bounded read reporting the page's
 * total as the period's total.
 *
 * `commission-accrual.spec.ts` proves the arithmetic — that the parts of one
 * evaluation sum to its settled amount. That property is necessary and it is
 * not sufficient, because a truncated *read* of a correct ledger still adds up:
 * the five thousand parts that fit agree perfectly with the total of the five
 * thousand parts that fit, and `reconciles: true` would go out beside a figure
 * short by however many deals fell off the end. A rep reading "you have accrued
 * X, and here is the proof it adds up" has no way to see that X is not what
 * they are owed — which is the exact opposite of what a decomposable accrual is
 * for, and worse than not decomposing it at all.
 *
 * So these tests assert the two halves separately: the headline covers the
 * whole period regardless of the page, and the response admits when the
 * itemisation does not account for the headline.
 */

/**
 * A thenable Drizzle chain yielding the next queued result.
 *
 * Deliberately indifferent to which table was selected: the tests below assert
 * on the service's output, and the queue's *order* is how they control which
 * read gets which rows. That makes an accidentally-added query visible as a
 * failure rather than absorbing it silently.
 */
function makeSelect(queue: unknown[][]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit", "offset", "groupBy"])
    chain[method] = jest.fn(() => chain);
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(queue.shift() ?? []).then(resolve, reject);
  return chain;
}

const ORG = "org-1";
const USER = "user-1";
const PLAN = "plan-1";
const VERSION = "ver-1";

/** The page sizes the service uses (`lib/accrual-parts.ts`). Mirrored, not imported. */
const PERIOD_PART_PAGE = 5_000;
const DEAL_PART_PAGE = 500;

interface Harness {
  service: CommissionAccrualService;
  queue: unknown[][];
}

async function harness(): Promise<Harness> {
  const queue: unknown[][] = [];
  const db = { select: jest.fn(() => makeSelect(queue)) };
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [CommissionAccrualService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return { service: moduleRef.get(CommissionAccrualService), queue };
}

/** One stored part row, with only the fields the read paths actually touch. */
function part(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    partId: "part-x",
    orgId: ORG,
    earningId: "earn-1",
    userId: USER,
    planId: PLAN,
    planVersionId: VERSION,
    earnedOn: "2026-03-04",
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    sourceType: "deal",
    sourceId: "1",
    partIndex: 0,
    tierIndex: 0,
    tierFrom: 0,
    rateBps: 500,
    multiplierBps: 10_000,
    sliceFromMinor: 0,
    sliceToMinor: 100_000,
    basisMinor: 100_000,
    amountMinor: 5_000,
    currency: "INR",
    ...overrides,
  };
}

/** The two reads `resolvePeriod` performs, in order. */
function queuePeriodResolution(queue: unknown[][]) {
  queue.push([{ planId: PLAN, userId: USER, orgId: ORG, effectiveFrom: "2026-01-01" }]);
  queue.push([
    {
      planVersionId: VERSION,
      planId: PLAN,
      versionNumber: 1,
      effectiveFrom: "2026-01-01",
      rules: {
        basis: "deal_value",
        period: "MONTH",
        quotaMinor: null,
        tiers: [{ from: 0, rateBps: 500 }],
        accelerators: [],
        capMinor: null,
      },
    },
  ]);
}

const VIEWER = { userId: USER, viewAll: false };
const ON = { on: "2026-03-15" } as const;

describe("periodAccrual", () => {
  it("sums the page when the page holds the period", async () => {
    const { service, queue } = await harness();
    queuePeriodResolution(queue);
    queue.push([
      part({ earningId: "earn-1", sourceId: "1", amountMinor: 5_000 }),
      part({ earningId: "earn-2", sourceId: "2", amountMinor: 7_000 }),
    ]);
    queue.push([
      { id: 1, name: "Acme" },
      { id: 2, name: "Globex" },
    ]);
    queue.push([{ attainmentBps: 12_000 }]);

    const result = await service.periodAccrual(ORG, ON, VIEWER);

    expect(result.truncated).toBe(false);
    expect(result.amountMinor).toBe(12_000);
    expect(result.partCount).toBe(2);
    expect(result.itemisedPartCount).toBe(2);
    expect(result.reconciles).toEqual({ byDeal: true, byRule: true });
    expect(result.deals.map((deal) => deal.dealName)).toEqual(["Acme", "Globex"]);
    // No aggregate query was issued: the earning read was still at the front of
    // the queue when it ran, so nothing consumed a slot in between.
    expect(result.attainmentBps).toBe(12_000);
  });

  /**
   * The headline must not shrink to fit the page.
   *
   * The aggregate here reports a total larger than the page can account for —
   * which is what postgres would return, since it sums the period and the page
   * is the period's first five thousand rows.
   */
  it("reports the whole period's figure when the itemisation is truncated", async () => {
    const { service, queue } = await harness();
    queuePeriodResolution(queue);

    const overflowing = Array.from({ length: PERIOD_PART_PAGE + 1 }, (_, index) =>
      part({ earningId: `earn-${index}`, sourceId: String(index + 1), amountMinor: 100 }),
    );
    queue.push(overflowing);
    queue.push([]); // deal names
    // `sum()` over bigint arrives as a string; the service must not treat it as
    // a float or a count.
    queue.push([{ accrued: "900000", basis: "18000000", parts: "9000" }]);
    queue.push([{ attainmentBps: 20_000 }]);

    const result = await service.periodAccrual(ORG, ON, VIEWER);

    expect(result.truncated).toBe(true);
    expect(result.amountMinor).toBe(900_000);
    expect(result.basisMinor).toBe(18_000_000);
    expect(result.partCount).toBe(9_000);
    expect(result.itemisedPartCount).toBe(PERIOD_PART_PAGE);
    expect(result.deals).toHaveLength(PERIOD_PART_PAGE);
  });

  /**
   * And it must say so. A truncated response that claimed to reconcile would be
   * the understated figure wearing a proof — the one outcome worse than either.
   */
  it("refuses to claim reconciliation it cannot demonstrate", async () => {
    const { service, queue } = await harness();
    queuePeriodResolution(queue);
    queue.push(
      Array.from({ length: PERIOD_PART_PAGE + 1 }, (_, index) =>
        part({ earningId: `earn-${index}`, sourceId: String(index + 1), amountMinor: 100 }),
      ),
    );
    queue.push([]); // deal names
    queue.push([{ accrued: "900000", basis: "18000000", parts: "9000" }]);
    queue.push([]);

    const result = await service.periodAccrual(ORG, ON, VIEWER);

    expect(result.reconciles).toEqual({ byDeal: false, byRule: false });
  });
});

describe("byDeal", () => {
  it("reconciles when every part fits", async () => {
    const { service, queue } = await harness();
    queue.push([
      part({ userId: USER, partIndex: 0, amountMinor: 5_000, basisMinor: 100_000 }),
      part({ userId: USER, partIndex: 1, amountMinor: 2_500, basisMinor: 50_000 }),
    ]);

    const result = await service.byDeal(ORG, 1, VIEWER);

    expect(result.truncated).toBe(false);
    expect(result.amountMinor).toBe(7_500);
    expect(result.basisMinor).toBe(150_000);
    expect(result.partCount).toBe(2);
    expect(result.reconciles).toBe(true);
    expect(result.parts).toHaveLength(2);
  });

  it("keeps the deal's full figure when the split overflows the page", async () => {
    const { service, queue } = await harness();
    queue.push(
      Array.from({ length: DEAL_PART_PAGE + 1 }, (_, index) =>
        part({ userId: `user-${index}`, partIndex: index, amountMinor: 100 }),
      ),
    );
    queue.push([{ accrued: "60100", basis: "1200000", parts: "601" }]);

    const result = await service.byDeal(ORG, 1, { userId: USER, viewAll: true });

    expect(result.truncated).toBe(true);
    expect(result.amountMinor).toBe(60_100);
    expect(result.partCount).toBe(601);
    expect(result.parts).toHaveLength(DEAL_PART_PAGE);
    expect(result.reconciles).toBe(false);
  });
});
