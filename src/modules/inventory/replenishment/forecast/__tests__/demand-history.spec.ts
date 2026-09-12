import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../../../db/drizzle.module";
import { demandHistory } from "../lib/demand-history";

/**
 * The 260-week ceiling on the demand history, which nothing asserted.
 *
 * Found by mutation when the extraction moved out of
 * `demand-baseline.service.ts` into `lib/demand-history.ts`: replacing
 * `Math.min(options.weeks ?? 52, 260)` with `options.weeks ?? 52` left the
 * whole inventory suite green (173 suites, 1783 tests). The ceiling is the only
 * thing between a caller-supplied `weeks` and the size of the `generate_series`
 * spine — and of the window function walked over it — so without it one request
 * can ask Postgres for a million-week series. It is a resource bound in the
 * sense CLAUDE.md §4 means, and deleting it would read as a cleanup.
 *
 * The first parameter the statement binds is `weeks - 1`, the spine's offset
 * back from the current week; that is what these cases read.
 */

type Row = { period: string; quantity: string; closing_on_hand: string };

function harness(rows: Row[] = []) {
  const execute = jest.fn<Promise<Row[]>, [SQL]>(async () => rows);
  return { db: { execute } as unknown as Db, execute };
}

function spineOffset(execute: jest.Mock<Promise<Row[]>, [SQL]>): unknown {
  const statement = execute.mock.calls[0]![0];
  return new PgDialect().sqlToQuery(statement).params[0];
}

describe("demandHistory — the window it will ask for", () => {
  it("caps a huge request at 260 weeks", async () => {
    const h = harness();
    await demandHistory(h.db, "org-1", 7, { weeks: 100_000 });
    expect(spineOffset(h.execute)).toBe(259);
  });

  it("takes exactly 260 weeks when asked for exactly 260", async () => {
    const h = harness();
    await demandHistory(h.db, "org-1", 7, { weeks: 260 });
    expect(spineOffset(h.execute)).toBe(259);
  });

  it("defaults to a year", async () => {
    const h = harness();
    await demandHistory(h.db, "org-1", 7);
    expect(spineOffset(h.execute)).toBe(51);
  });

  it("honours a short window below the cap (control)", async () => {
    const h = harness();
    await demandHistory(h.db, "org-1", 7, { weeks: 8 });
    expect(spineOffset(h.execute)).toBe(7);
  });
});

describe("demandHistory — the rows it returns (control)", () => {
  it("flags a period that closed with nothing on hand as censored, and passes the rest through", async () => {
    const h = harness([
      { period: "2026-08-31", quantity: "3.0000", closing_on_hand: "0.0000" },
      { period: "2026-09-07", quantity: "2.0000", closing_on_hand: "5.0000" },
    ]);

    const history = await demandHistory(h.db, "org-1", 7, { weeks: 2 });
    expect(history.map((p) => [p.period, p.closingOnHand, p.stockoutCensored])).toEqual([
      ["2026-08-31", "0.0000", true],
      ["2026-09-07", "5.0000", false],
    ]);
  });
});
