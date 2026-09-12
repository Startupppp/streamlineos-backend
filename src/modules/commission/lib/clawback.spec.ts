jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db),
}));

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { crmCommissionAccrualParts, crmCommissionEarnings } from "../../../db/schema/crm/commission";
import { clawbackEarningForDeal } from "./clawback";

const ORG = "org-1";
const DEAL_ID = 42;
const USER = "usr-1";

const SLICES = [
  { fromMinor: 0, toMinor: 500_000, basisMinor: 500_000, tierIndex: 0, tierFrom: 0, rateBps: 1000, multiplierBps: 10_000 },
  { fromMinor: 500_000, toMinor: 1_000_000, basisMinor: 500_000, tierIndex: 1, tierFrom: 500_000, rateBps: 1500, multiplierBps: 10_000 },
];

function originalEarning(overrides: Partial<typeof crmCommissionEarnings.$inferSelect> = {}) {
  return {
    earningId: "earn-1",
    orgId: ORG,
    planId: "plan-1",
    planVersionId: "ver-1",
    userId: USER,
    earnedOn: "2026-01-10",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    sourceType: "deal",
    sourceId: String(DEAL_ID),
    basisMinor: 1_000_000,
    priorBasisMinor: 0,
    amountMinor: 125_000,
    currency: "INR",
    effectiveRateBps: 1250,
    attainmentBps: 5000,
    computation: { slices: SLICES, quotaMinor: 2_000_000, capped: false },
    status: "APPROVED",
    approvedBy: null,
    approvedAt: null,
    createdAt: new Date("2026-01-10T00:00:00Z"),
    updatedAt: new Date("2026-01-10T00:00:00Z"),
    ...overrides,
  } as typeof crmCommissionEarnings.$inferSelect;
}

/** A `db` double keyed by table identity, matching this repo's usual style for these fixtures. */
function fakeTx(options: {
  original: (typeof crmCommissionEarnings.$inferSelect)[];
  alreadyClawedBack?: (typeof crmCommissionEarnings.$inferSelect)[];
  accruedSoFar?: number;
}) {
  const inserted: { table: unknown; row: Record<string, unknown> }[] = [];
  let originalSelectDone = false;

  return {
    tx: {
      select: (_cols?: unknown) => ({
        from: (table: unknown) => ({
          where: (..._args: unknown[]) => {
            if (table === crmCommissionEarnings) {
              // First select is the original-by-source lookup; the second
              // (only reached on a conflict) is the already-clawed-back read.
              const rows = originalSelectDone ? (options.alreadyClawedBack ?? []) : options.original;
              originalSelectDone = true;
              return {
                orderBy: () => ({ limit: async () => rows }),
                limit: async () => rows,
              };
            }
            if (table === crmCommissionAccrualParts) {
              return { then: (resolve: (v: unknown) => unknown) => resolve([{ accrued: String(options.accruedSoFar ?? 0) }]) };
            }
            throw new Error("unexpected select table");
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          inserted.push({ table, row });
          if (table === crmCommissionEarnings) {
            return {
              onConflictDoNothing: () => ({
                returning: async () => (options.alreadyClawedBack ? [] : [{ ...row, earningId: "clawback-1" }]),
              }),
            };
          }
          // accrual parts / snapshot inserts — snapshot chains onConflictDoUpdate,
          // parts is awaited bare; support both off one object.
          return {
            then: (resolve: (v: unknown) => unknown) => resolve(undefined),
            onConflictDoUpdate: async () => undefined,
          };
        },
      }),
      delete: (_table: unknown) => ({ where: async () => undefined }),
    },
    inserted,
  };
}

describe("clawbackEarningForDeal", () => {
  it("refuses when the deal was never commissioned", async () => {
    const { tx } = fakeTx({ original: [] });
    await expect(
      clawbackEarningForDeal(tx as never, ORG, { dealId: DEAL_ID, reason: "lost", actorUserId: "actor-1" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses to reverse a voided earning", async () => {
    const { tx } = fakeTx({ original: [originalEarning({ status: "VOID" })] });
    await expect(
      clawbackEarningForDeal(tx as never, ORG, { dealId: DEAL_ID, reason: "lost", actorUserId: "actor-1" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("mirrors the original amount exactly, negated, and inserts under a distinct source type", async () => {
    const { tx, inserted } = fakeTx({ original: [originalEarning()] });

    const result = await clawbackEarningForDeal(tx as never, ORG, {
      dealId: DEAL_ID,
      reason: "Deal moved from CLOSED_WON to LOST",
      actorUserId: "actor-1",
    });

    expect(result.created).toBe(true);
    expect(result.amountMinor).toBe(-125_000);
    expect(result.reversedEarningId).toBe("earn-1");
    expect(result.userId).toBe(USER);

    const earningInsert = inserted.find((i) => i.table === crmCommissionEarnings);
    expect(earningInsert?.row.sourceType).toBe("deal_reversal");
    expect(earningInsert?.row.sourceId).toBe(String(DEAL_ID));
    expect(earningInsert?.row.amountMinor).toBe(-125_000);
    expect(earningInsert?.row.basisMinor).toBe(-1_000_000);
    expect((earningInsert?.row.computation as Record<string, unknown>).reason).toBe(
      "Deal moved from CLOSED_WON to LOST",
    );

    // The parts mirror the original's decomposition, negated, and still
    // reconstruct the total — the same invariant `assertPartsSumTo` checks
    // for a normal earning, now checked on the way INTO recordAccrualForEarning.
    const partsInsert = inserted.find((i) => i.table === crmCommissionAccrualParts);
    const parts = partsInsert?.row as unknown as { amountMinor: number }[];
    expect(Array.isArray(parts)).toBe(true);
  });

  it("flags a clawback that would take the period's accrual negative, without shrinking the amount", async () => {
    const { tx } = fakeTx({ original: [originalEarning({ amountMinor: 125_000 })], accruedSoFar: 100_000 });

    const result = await clawbackEarningForDeal(tx as never, ORG, {
      dealId: DEAL_ID,
      reason: "reclassified",
      actorUserId: "actor-1",
    });

    // 100,000 accrued so far - 125,000 clawed back = -25,000: negative.
    expect(result.drivesNegative).toBe(true);
    expect(result.amountMinor).toBe(-125_000); // never partial
  });

  it("does not flag a clawback the period can absorb", async () => {
    const { tx } = fakeTx({ original: [originalEarning({ amountMinor: 50_000 })], accruedSoFar: 200_000 });

    const result = await clawbackEarningForDeal(tx as never, ORG, {
      dealId: DEAL_ID,
      reason: "reclassified",
      actorUserId: "actor-1",
    });

    expect(result.drivesNegative).toBe(false);
  });

  it("is idempotent — a second clawback for the same deal reads back the first rather than duplicating it", async () => {
    const existing = originalEarning({
      earningId: "clawback-1",
      sourceType: "deal_reversal",
      amountMinor: -125_000,
      computation: { reversedEarningId: "earn-1", reason: "lost", drivesNegative: false },
    });
    const { tx } = fakeTx({ original: [originalEarning()], alreadyClawedBack: [existing] });

    const result = await clawbackEarningForDeal(tx as never, ORG, {
      dealId: DEAL_ID,
      reason: "lost",
      actorUserId: "actor-1",
    });

    expect(result.created).toBe(false);
    expect(result.amountMinor).toBe(-125_000);
  });

  it("refuses when the original earning predates this ticket and carries no slices to mirror", async () => {
    const { tx } = fakeTx({ original: [originalEarning({ computation: { note: "pre-ticket-06 row" } })] });
    await expect(
      clawbackEarningForDeal(tx as never, ORG, { dealId: DEAL_ID, reason: "lost", actorUserId: "actor-1" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
