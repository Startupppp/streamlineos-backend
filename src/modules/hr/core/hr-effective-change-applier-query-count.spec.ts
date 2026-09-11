import { makeCountingDb } from "../../../db/__tests__/counting-db";
import type { Db } from "../../../db/drizzle.types";
import { HrAuditService } from "./hr-audit.service";
import { HrEffectiveChangeApplierService } from "./hr-effective-change-applier.service";

/**
 * `applyDue` is classified PARTIALLY-BATCHED, and this file asserts exactly that
 * split rather than the prettier claim.
 *
 * READS are hoisted: the advisory lock, the due page, the employment preload and
 * the job-level preload are four statements whether the page holds one change or
 * fifty. That is the half the N+1 fix bought, and it is asserted as a constant.
 *
 * WRITES stay per change on purpose. Each branch validates the row it is applying
 * and has to throw for that row, and department/location sync placement only when
 * the person carries a `userId`, so a bulk update keyed by change type would drop
 * both. Asserting `updates === batch + 1` pins the deliberate shape: a future
 * change that quietly makes the writes grow FASTER than the batch, or that adds a
 * second read per change, fails here.
 */

const ORG = "org-effective-changes";
const BATCH_SIZES = [1, 50] as const;

function repeat<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_unused, index) => make(index));
}

function changeRows(count: number, changeType: string, newValue: (index: number) => unknown) {
  return repeat(count, (index) => ({
    id: index + 1,
    employmentId: index + 1,
    changeType,
    oldValue: null,
    newValue: newValue(index),
    effectiveFrom: "2026-01-01",
    effectiveTo: "9999-12-31",
  }));
}

/** `userId: null` keeps a designation batch off the placement-sync branch, which
 *  is conditional and would otherwise add statements this budget does not cover. */
function employmentRows(count: number) {
  return repeat(count, (index) => ({ id: index + 1, userId: null }));
}

interface Harness {
  service: HrEffectiveChangeApplierService;
  statements: () => number;
  countOf: (op: "select" | "insert" | "update" | "delete" | "execute" | "transaction" | "query") => number;
  reads: () => number;
}

function harness(due: ReturnType<typeof changeRows>, extraSelects: unknown[] = []): Harness {
  const counting = makeCountingDb({
    execute: [[]],
    select: [due, employmentRows(due.length), ...extraSelects],
    update: [
      ...repeat(due.length, () => [{ id: 1 }]),
      due.map((change) => ({ id: change.id })),
    ],
  });
  const db = counting.db as Db;
  return {
    service: new HrEffectiveChangeApplierService(db, new HrAuditService(db)),
    statements: counting.statements,
    countOf: counting.countOf,
    reads: () => counting.countOf("select") + counting.countOf("execute"),
  };
}

describe("HrEffectiveChangeApplierService.applyDue — statement count", () => {
  it("reads a batch of 50 in the same three statements it reads a batch of 1", async () => {
    const readCounts: number[] = [];
    const totals: number[] = [];

    for (const size of BATCH_SIZES) {
      const due = changeRows(size, "designation", (index) => ({
        designation: `Senior Engineer ${String(index + 1)}`,
      }));
      const { service, reads, statements, countOf } = harness(due);

      await expect(service.applyDue(ORG, null, "2026-06-01", 500)).resolves.toEqual({
        applied: size,
        hasMore: false,
      });

      // advisory lock + due page + employment preload. Nothing per change.
      expect(reads()).toBe(3);
      expect(countOf("execute")).toBe(1);
      expect(countOf("select")).toBe(2);
      readCounts.push(reads());
      totals.push(statements());
    }

    expect(readCounts[0]).toBe(readCounts[1]);
    expect(totals).toEqual([6, 55]);
  });

  it("preloads every job level in one statement, whatever the batch size", async () => {
    const readCounts: number[] = [];

    for (const size of BATCH_SIZES) {
      const due = changeRows(size, "job_level", (index) => ({ jobLevelId: index + 1 }));
      const levels = repeat(size, (index) => ({ id: index + 1 }));
      const { service, reads, countOf } = harness(due, [levels]);

      await expect(service.applyDue(ORG, null, "2026-06-01", 500)).resolves.toEqual({
        applied: size,
        hasMore: false,
      });

      // advisory lock + due page + employment preload + ONE job-level preload,
      // for 1 distinct level and for 50.
      expect(reads()).toBe(4);
      expect(countOf("select")).toBe(3);
      readCounts.push(reads());
    }

    expect(readCounts[0]).toBe(readCounts[1]);
  });

  it("writes once per change plus one batch mark and one batched audit insert", async () => {
    for (const size of BATCH_SIZES) {
      const due = changeRows(size, "designation", (index) => ({
        designation: `Senior Engineer ${String(index + 1)}`,
      }));
      const { service, countOf } = harness(due);

      await service.applyDue(ORG, null, "2026-06-01", 500);

      // Deliberate: one UPDATE per change, because each branch must throw for its
      // own row. Plus the single mark-applied UPDATE over the whole page.
      expect(countOf("update")).toBe(size + 1);
      // The audit trail is batched — one multi-row INSERT for the whole page.
      expect(countOf("insert")).toBe(1);
    }
  });

  it("issues two statements and no write when nothing is due", async () => {
    const { service, statements, countOf } = harness(changeRows(0, "designation", () => ({})));

    await expect(service.applyDue(ORG, null, "2026-06-01", 500)).resolves.toEqual({
      applied: 0,
      hasMore: false,
    });

    expect(statements()).toBe(2);
    expect(countOf("execute")).toBe(1);
    expect(countOf("select")).toBe(1);
    expect(countOf("update")).toBe(0);
    expect(countOf("insert")).toBe(0);
  });
});
