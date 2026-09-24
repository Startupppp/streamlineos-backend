import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { RecruitmentVendorSourcingService } from "../recruitment-vendor-sourcing.service";
import { candidates, jobPostings, vendorCandidateSubmissions } from "../../../../db/schema";

/**
 * ATS-W1-019's stated acceptance: a vendor cannot see another vendor's
 * candidates, and one tenant cannot see another's vendors at all.
 *
 * Asserted on the SQL the service builds rather than on a stubbed return value.
 * A double that hands back the right rows proves the mapping and nothing about
 * the predicate, and the predicate is the entire feature — this is a surface a
 * competing agency is given a link to.
 */

const OWNER = "org-owner";
const ATTACKER = "org-attacker";

/** Collects the `where` and join conditions the service actually passes. */
function captureDb(vendorRow: unknown, rows: unknown[] = []) {
  const captured: { where: unknown[]; joins: unknown[] } = { where: [], joins: [] };
  const chain: Record<string, unknown> = {};
  chain.select = jest.fn(() => chain);
  chain.from = jest.fn(() => chain);
  chain.leftJoin = jest.fn((_table: unknown, on: unknown) => {
    captured.joins.push(on);
    return chain;
  });
  chain.where = jest.fn((condition: unknown) => {
    captured.where.push(condition);
    return chain;
  });
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve(rows));

  const db = {
    ...chain,
    query: {
      recruitmentVendors: { findFirst: jest.fn(() => Promise.resolve(vendorRow)) },
    },
  } as unknown as Db;

  return { db, captured };
}

function build(db: Db) {
  return new RecruitmentVendorSourcingService(db);
}

/*
  Drizzle's condition tree is cyclic — a column points back at its table, which
  points at its columns — so both walks carry a visited set. Without one the
  traversal is a stack overflow rather than a failing assertion, which reads
  like a broken test instead of a broken predicate.
*/
function walk(node: unknown, visit: (record: Record<string, unknown>) => void): void {
  const seen = new WeakSet<object>();
  const recurse = (current: unknown): void => {
    if (current === null || typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);
    visit(current as Record<string, unknown>);
    for (const value of Object.values(current as Record<string, unknown>)) recurse(value);
  };
  recurse(node);
}

/** Every literal bound into a condition tree. */
function boundValues(node: unknown): unknown[] {
  const found: unknown[] = [];
  walk(node, (record) => {
    if ("value" in record && typeof record.value !== "object") found.push(record.value);
  });
  return found;
}

/** Column names referenced anywhere in a condition tree. */
function columnNames(node: unknown): string[] {
  const found: string[] = [];
  walk(node, (record) => {
    if (typeof record.name === "string" && "table" in record) found.push(record.name);
  });
  return found;
}

/** Table names referenced anywhere in a condition tree. */
function tableNames(node: unknown): string[] {
  const found: string[] = [];
  walk(node, (record) => {
    const table = record.table as Record<string, unknown> | undefined;
    for (const symbol of table ? Object.getOwnPropertySymbols(table) : []) {
      const value = (table as Record<symbol, unknown>)[symbol];
      if (typeof value === "string") found.push(value);
    }
  });
  return found;
}

describe("vendor isolation — a vendor from another tenant", () => {
  it("is not found, rather than forbidden", async () => {
    const { db } = captureDb(undefined);
    await expect(build(db).listSubmissions(ATTACKER, 1, true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /**
   * 404 and not 403. A 403 on another tenant's vendor id confirms the vendor
   * exists, which turns an id probe into a directory of who a competitor's
   * agencies are.
   */
  it("never reveals that the vendor exists", async () => {
    const { db } = captureDb(undefined);
    await expect(build(db).listSubmissions(ATTACKER, 1, true)).rejects.toThrow(/not found/i);
  });

  it("reads no submissions at all once the vendor check fails", async () => {
    const { db, captured } = captureDb(undefined);
    await build(db)
      .listSubmissions(ATTACKER, 1, true)
      .catch(() => undefined);
    expect(captured.where).toHaveLength(0);
  });
});

describe("vendor isolation — the submissions read itself", () => {
  const vendor = { id: 7, orgId: OWNER, name: "Acme Staffing" };

  it("binds the caller's org AND the vendor, not the vendor alone", async () => {
    const { db, captured } = captureDb(vendor);
    await build(db).listSubmissions(OWNER, 7, true);

    const where = captured.where.at(-1);
    expect(boundValues(where)).toEqual(expect.arrayContaining([OWNER, 7]));
    expect(columnNames(where)).toEqual(expect.arrayContaining(["org_id", "vendor_id"]));
  });

  /**
   * The predicate is on the submissions table, not only on the vendor lookup.
   * Relying on `ensureVendor` plus RLS means the guard stops holding the first
   * time this read is called without a tenant GUC — from a background job, a
   * cron sweep, or a test harness.
   */
  it("scopes the submissions table itself and not just the vendor lookup", async () => {
    const { db, captured } = captureDb(vendor);
    await build(db).listSubmissions(OWNER, 7, true);

    expect(tableNames(captured.where.at(-1))).toEqual(
      expect.arrayContaining(["vendor_candidate_submissions"]),
    );
  });

  it("joins the candidate and the job on org_id as well as id", async () => {
    const { db, captured } = captureDb(vendor);
    await build(db).listSubmissions(OWNER, 7, true);

    expect(captured.joins).toHaveLength(2);
    for (const join of captured.joins) {
      expect(columnNames(join)).toEqual(expect.arrayContaining(["org_id"]));
    }
  });
});

describe("vendor isolation — what a reader without financial standing sees", () => {
  const vendor = { id: 7, orgId: OWNER, name: "Acme Staffing" };
  const row = {
    id: 1,
    candidateId: 2,
    jobPostingId: 3,
    billRate: "100.10",
    payRate: "33.37",
    candidateFirstName: "Asha",
    candidateLastName: "Menon",
  };

  it("gives the rates and an exact margin to a reader who may see them", async () => {
    const { db } = captureDb(vendor, [row]);
    const [out] = (await build(db).listSubmissions(OWNER, 7, true)) as Record<string, unknown>[];

    expect(out.billRate).toBe("100.10");
    expect(out.marginAmount).toBe("66.73");
    expect(out.marginPercent).toBe(66.7);
  });

  /**
   * The rates are nulled AND the margin with them. Returning a margin while
   * hiding its inputs hands the reader the commercially sensitive number and
   * only pretends to withhold it — pay rate is bill minus margin.
   */
  it("withholds the margin too, not just the rates it is computed from", async () => {
    const { db } = captureDb(vendor, [row]);
    const [out] = (await build(db).listSubmissions(OWNER, 7, false)) as Record<string, unknown>[];

    expect(out.billRate).toBeNull();
    expect(out.payRate).toBeNull();
    expect(out.marginAmount).toBeNull();
    expect(out.marginPercent).toBeNull();
  });

  it("still returns the non-financial columns, so the screen is not empty", async () => {
    const { db } = captureDb(vendor, [row]);
    const [out] = (await build(db).listSubmissions(OWNER, 7, false)) as Record<string, unknown>[];

    expect(out.candidateFirstName).toBe("Asha");
    expect(out.id).toBe(1);
  });
});

/** Referenced so a schema rename breaks this file rather than silencing it. */
void [candidates, jobPostings, vendorCandidateSubmissions];
