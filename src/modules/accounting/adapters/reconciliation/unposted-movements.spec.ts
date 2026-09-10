import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { join } from "node:path";
import { UnpostedMovementsService } from "./unposted-movements.service";
import { unpostedMovementsQuerySchema } from "./reconciliation.controller";

/**
 * ACC-08. Stock that moved and never reached the ledger.
 *
 * `docs/inventory-gl-contract.md` §3.4: ten of the thirteen services that move
 * stock never post at all. On an accounting-enabled tenant a scrap, a
 * cycle-count loss, a quality write-off and a customer return each change the
 * value of stock on hand and leave the inventory GL account exactly as it was —
 * no error, no log, no failed request, because nothing ever tried. The stock
 * valuation report and the balance sheet disagree permanently and nothing says
 * so.
 *
 * The two reasons are kept apart because they call for opposite responses. A
 * `no_posting_path` movement is not the tenant's fault and cannot be fixed by
 * anyone in the product; a `post_missing` movement should be impossible — the
 * post shares the movement's own transaction (ACC-05) — so each one is a bug.
 * Collapsing them into one "unreconciled" number would make the second
 * invisible inside the first, which is the failure this report exists to end.
 */

interface Row {
  id: number;
  posting_date: string | null;
  transaction_type: string;
  reference_type: string | null;
  reference_id: string | null;
  total_cost: string;
  has_journal: boolean;
}

function serviceReturning(rows: Row[], book: { id: string } | null = { id: "book-1" }) {
  const db = { execute: async () => rows } as never;
  const books = { findDefault: async () => book } as never;
  return new UnpostedMovementsService(db, books);
}

function row(over: Partial<Row>): Row {
  return {
    id: 1,
    posting_date: "2026-09-01",
    transaction_type: "SCRAP",
    reference_type: "inv_adjustment",
    reference_id: "77",
    total_cost: "100.0000",
    has_journal: false,
    ...over,
  };
}

describe("stock that moved and never reached the ledger", () => {
  it("says nothing at all about an org that never enabled accounting", async () => {
    /*
      Such an org is SUPPOSED to have no journals. Listing every movement it
      ever made as unposted would be the loudest possible way to say nothing,
      and would bury the tenants where the number means something.
    */
    const service = serviceReturning([row({})], null);
    const report = await service.report("org-1", "2026-09-01", "2026-09-30");

    expect(report.enabled).toBe(false);
    expect(report.movements).toBe(0);
    expect(report.notes[0]).toMatch(/no stock movement is expected to post/);
  });

  it("counts a scrap that no call site would ever have posted", async () => {
    const service = serviceReturning([
      row({ id: 1, total_cost: "100.0000" }),
      row({ id: 2, total_cost: "250.5000" }),
    ]);
    const report = await service.report("org-1", "2026-09-01", "2026-09-30");

    expect(report.movements).toBe(2);
    expect(report.valueMinor).toBe(35050);
    expect(report.byReason).toEqual([
      { reason: "no_posting_path", movements: 2, valueMinor: 35050 },
    ]);
  });

  it("distinguishes a missing post from a missing posting path", async () => {
    const service = serviceReturning([
      row({ id: 1, transaction_type: "SCRAP", reference_type: "inv_adjustment" }),
      row({
        id: 2,
        transaction_type: "GRN",
        reference_type: "inv_grn",
        reference_id: "9",
        total_cost: "500.0000",
      }),
    ]);
    const report = await service.report("org-1", "2026-09-01", "2026-09-30");

    const reasons = Object.fromEntries(report.byReason.map((r) => [r.reason, r.movements]));
    expect(reasons).toEqual({ no_posting_path: 1, post_missing: 1 });

    /* And each one is told what to do about it, in the payload. */
    expect(report.notes.join(" ")).toMatch(/not a fault of this organisation's setup/);
    expect(report.notes.join(" ")).toMatch(/bug to investigate rather than a setting/);
  });

  it("excludes movements the query already matched to a journal", async () => {
    /*
      Anti-vacuity for `has_journal`: if the filter were dropped, a fully
      reconciled tenant would report every movement it ever made.
    */
    const service = serviceReturning([
      row({ id: 1, has_journal: true, reference_type: "inv_grn" }),
      row({ id: 2, has_journal: false }),
    ]);
    const report = await service.report("org-1", "2026-09-01", "2026-09-30");

    expect(report.movements).toBe(1);
    expect(report.sample.map((m) => m.transactionId)).toEqual([2]);
  });

  it("counts an outward movement at its magnitude, not as a negative", async () => {
    /*
      `total_cost` follows the movement's sign, so a scrap is negative. A report
      that summed the raw values would net a write-off against a receipt and
      report a smaller gap than exists — the one direction of error that makes
      a reconciliation worse than useless.
    */
    const service = serviceReturning([
      row({ id: 1, total_cost: "-400.0000" }),
      row({ id: 2, total_cost: "400.0000" }),
    ]);
    const report = await service.report("org-1", "2026-09-01", "2026-09-30");

    expect(report.valueMinor).toBe(80000);
  });

  it("breaks the total down by what moved, so the biggest gap is findable", async () => {
    const service = serviceReturning([
      row({ id: 1, transaction_type: "SCRAP", total_cost: "10.0000" }),
      row({ id: 2, transaction_type: "CYCLE_COUNT_LOSS", total_cost: "900.0000" }),
      row({ id: 3, transaction_type: "CYCLE_COUNT_LOSS", total_cost: "100.0000" }),
    ]);
    const report = await service.report("org-1", "2026-09-01", "2026-09-30");

    expect(report.byTransactionType[0]).toEqual({
      transactionType: "CYCLE_COUNT_LOSS",
      reason: "no_posting_path",
      movements: 2,
      valueMinor: 100000,
    });
  });

  it("always states the limit of its own shipment matching", async () => {
    /*
      A reconciliation that overstates its precision is worse than none, because
      it gets trusted. A shipment's stock transaction records the SALES ORDER
      and never the shipment, so on a partially shipped order one posted
      shipment makes the whole order look posted — and this report cannot see
      the difference.
    */
    const service = serviceReturning([]);
    const report = await service.report("org-1", "2026-09-01", "2026-09-30");

    expect(report.notes.join(" ")).toMatch(/matched at sales-order level/);
  });

  it("caps the sample without capping the count", async () => {
    const service = serviceReturning(
      Array.from({ length: 150 }, (_, i) => row({ id: i + 1, total_cost: "1.0000" })),
    );
    const report = await service.report("org-1", "2026-09-01", "2026-09-30");

    expect(report.movements).toBe(150);
    expect(report.valueMinor).toBe(15000);
    expect(report.sample).toHaveLength(100);
  });
});

describe("the query it accepts", () => {
  it("refuses a window that runs backwards", () => {
    const bad = unpostedMovementsQuerySchema.safeParse({
      from: "2026-09-30",
      to: "2026-09-01",
    });
    expect(bad.success).toBe(false);
  });

  it("refuses anything that is not a date, rather than passing it to SQL", () => {
    expect(
      unpostedMovementsQuerySchema.safeParse({ from: "yesterday", to: "2026-09-30" }).success,
    ).toBe(false);
  });

  it("is strict, so a typo'd filter is a 400 and not a silently ignored one", () => {
    expect(
      unpostedMovementsQuerySchema.safeParse({
        from: "2026-09-01",
        to: "2026-09-30",
        warehouse: "3",
      }).success,
    ).toBe(false);
  });

  it("accepts a real window", () => {
    expect(
      unpostedMovementsQuerySchema.safeParse({ from: "2026-09-01", to: "2026-09-30" }).success,
    ).toBe(true);
  });
});

describe("cross-tenant isolation of the raw query", () => {
  /*
    This service reaches the database through a raw `sql` template rather than
    the query builder, so no `eq(table.orgId, orgId)` guards it and RLS is the
    only other line of defence. RLS is real but is not the argument here: the
    query joins `inv_shipments` on nothing but `s.id::text = p.source_id`, and
    without its own `s.org_id` predicate another organisation's shipment could
    mark THIS organisation's movement as posted — a reconciliation that
    UNDER-reports, which is the one direction of error that makes it worse than
    having none.

    Asserted on the parameters the driver would actually receive, compiled
    through the real dialect, so this also pins that the values are bound rather
    than interpolated.
  */
  async function compiledQuery(orgId: string) {
    let built: { sql: string; params: unknown[] } | null = null;
    const db = {
      execute: async (query: SQL) => {
        built = new PgDialect().sqlToQuery(query);
        return [];
      },
    } as never;
    const books = { findDefault: async () => ({ id: "book-1" }) } as never;

    await new UnpostedMovementsService(db, books).report(orgId, "2026-09-01", "2026-09-30");
    if (built === null) throw new Error("the service never issued a query");
    return built as { sql: string; params: unknown[] };
  }

  it("binds the caller's org to the movements, the journals and the shipment join", async () => {
    const built = await compiledQuery("org-a");

    /* Three, not one: dropping any of them opens a different-org read. */
    expect(built.params.filter((v) => v === "org-a")).toHaveLength(3);
    /* And the book, so another org's journals cannot satisfy this org's movements. */
    expect(built.params).toContain("book-1");
  });

  it("binds every value rather than interpolating it into the statement", async () => {
    /*
      The window arrives from a query string. It is regex-validated at the
      controller, but a raw template that inlined it would make that validation
      the only thing standing between a URL and the ledger.
    */
    const built = await compiledQuery("org-a");

    expect(built.sql).not.toContain("org-a");
    expect(built.sql).not.toContain("2026-09-01");
    expect(built.params).toEqual(
      expect.arrayContaining(["org-a", "2026-09-01", "2026-09-30", "book-1"]),
    );
  });
});

describe("the report is reachable", () => {
  it("is mounted, not just written", () => {
    /*
      A service nothing routes to is the defect this pack keeps finding one
      layer up — `PATCH accounts/:id/system-tag` had no caller for a year.
    */
    const module = readFileSync(join(__dirname, "../accounting-adapters.module.ts"), "utf8");
    expect(module).toContain("controllers: [ReconciliationController]");
    expect(module).toContain("UnpostedMovementsService");
  });

  it("reads inventory from the adapter layer, where a boundary crossing is allowed to show", () => {
    /*
      Not under `reports/`. Every service there reads the ledger and nothing
      else, which is what makes a report trustworthy; this one has to read
      `inv_stock_transactions` too, and hiding that among the statements would
      make the reporting layer depend on inventory's column names.
    */
    expect(__dirname).toContain("adapters");
    const service = readFileSync(join(__dirname, "unposted-movements.service.ts"), "utf8");
    expect(service).toContain("inv_stock_transactions");
  });
});
