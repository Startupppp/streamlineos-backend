import fc from "fast-check";
import { PgDialect } from "drizzle-orm/pg-core";
import { availableQty } from "../decimal";
import { availableQtySql, availableQtySumSql } from "../available-sql";
import { dbSpecClient, dbSpecSuite, dbSpecUrl } from "../../../../test/db-spec-gate";
import { fromUlps, levelUlps, type LevelUlps } from "./quantity-arbitraries";

/**
 * T16 — the two halves of the availability formula, differentially tested
 * against PostgreSQL over generated rows.
 *
 * `available-formula-single-definition.spec.ts` beside this file holds the line
 * that nobody writes a *third* copy of the formula. It cannot say the two
 * blessed copies agree — it reads source and greps for hand-written
 * subtraction. `availableQty` (TypeScript) and `availableQtySql` (SQL) are
 * maintained by hand as a matched pair, and every term either of them has ever
 * gained was added to both by somebody remembering to. A1 exists because
 * `outgoing_qty` was added to none of six copies; A2 and NEO-11 each added a
 * *gate* rather than a term, and a gate is the easier thing to get subtly
 * different, because it is where the two languages stop agreeing about null.
 *
 * So this generates stock levels with the same arbitraries the pure property
 * suite uses, computes availability in TypeScript, and makes PostgreSQL compute
 * it with the real `availableQtySql` expression. Any row where the two differ
 * is printed with its inputs.
 *
 * ## Three-valued logic is the point, not an edge case
 *
 * `ownership` NULL reaches `${a}.ownership <> 'OWNED'` as NULL, so the gate
 * condition is `false OR NULL` = NULL, the `WHEN` is not true, and the row
 * falls to the arithmetic — which is what the TypeScript half does for a `null`
 * ownership, by an entirely different mechanism. A location row that is missing
 * altogether makes the `EXISTS` false, which is `is_sellable` `undefined` on
 * the TypeScript side. Neither of those correspondences is enforced anywhere;
 * both are generated here.
 *
 * ## How the SQL is isolated
 *
 * The expression is rendered by drizzle's own dialect — the same text the
 * application sends — and evaluated over a CTE named `avail_probe` in place of
 * `inv_stock_levels`, with a second CTE shadowing `inv_locations`. No fixture,
 * no organisation, no RLS context, and nothing written to any table.
 *
 * The location ids are negative so they cannot collide with a real row. If the
 * shadowing ever stopped working — a schema qualifier appearing in the
 * expression, say — every non-sellable row would silently fall through to the
 * arithmetic and disagree with TypeScript, so the suite fails loudly rather
 * than quietly measuring nothing. `gateWithdrewStock` below is the explicit
 * floor for that: it counts rows the location gate actually zeroed out of a
 * positive arithmetic result, and requires there to have been some.
 */

const SUITE = dbSpecSuite();
const ROWS = 300;

/** Location ids in the shadow CTE, one per `is_sellable` state, plus one absent. */
const LOCATION_SELLABLE = -1;
const LOCATION_NOT_SELLABLE = -2;
const LOCATION_NULL_SELLABLE = -3;
/** Deliberately not inserted: a row whose location cannot be read at all. */
const LOCATION_MISSING = -4;

function locationIdFor(isSellable: boolean | null | undefined): number {
  if (isSellable === false) return LOCATION_NOT_SELLABLE;
  if (isSellable === true) return LOCATION_SELLABLE;
  if (isSellable === null) return LOCATION_NULL_SELLABLE;
  return LOCATION_MISSING;
}

interface ProbeRow {
  index: number;
  level: LevelUlps;
  /** Which of the three nullable buckets are stored NULL rather than zero. */
  nulled: { blocked: boolean; qualityHold: boolean; outgoing: boolean };
}

function bucketText(value: bigint, isNull: boolean): string | null {
  return isNull ? null : fromUlps(value);
}

function tsAnswer(row: ProbeRow): string {
  return availableQty({
    on_hand: fromUlps(row.level.onHand),
    committed: fromUlps(row.level.committed),
    blocked_qty: bucketText(row.level.blocked, row.nulled.blocked),
    quality_hold_qty: bucketText(row.level.qualityHold, row.nulled.qualityHold),
    outgoing_qty: bucketText(row.level.outgoing, row.nulled.outgoing),
    is_sellable: row.level.isSellable,
    ownership: row.level.ownership,
  });
}

SUITE("T16 property (database) — availableQty and availableQtySql agree row for row", () => {
  const dialect = new PgDialect();
  let sql: ReturnType<typeof dbSpecClient> | null = null;
  let rows: ProbeRow[] = [];

  /**
   * Resolved in `beforeAll`, not in the describe body. `describe.skip` still
   * *executes* its callback — it registers the tests and marks them skipped —
   * so `dbSpecUrl` throwing at that level fails the whole file with "Test suite
   * failed to run" on any run without a database, which is the opposite of
   * skipping loudly. Caught by running `--testPathPattern=available-formula`
   * with no `DATABASE_URL`: `EXIT=1`, 0 tests.
   */
  function db(): ReturnType<typeof dbSpecClient> {
    if (sql === null) throw new Error("the client is created in beforeAll");
    return sql;
  }

  beforeAll(() => {
    sql = dbSpecClient(dbSpecUrl("DATABASE_URL"));
    const levels = fc.sample(levelUlps, ROWS);
    const nulls = fc.sample(
      fc.record({ blocked: fc.boolean(), qualityHold: fc.boolean(), outgoing: fc.boolean() }),
      ROWS,
    );
    rows = levels.map((level, index) => {
      const nulled = nulls[index];
      if (nulled === undefined) throw new Error("sample lengths diverged");
      return { index, level, nulled };
    });
  });

  afterAll(async () => {
    if (sql !== null) await sql.end();
  });

  /** Every bound value is a decimal string, a small integer or NULL. */
  type ProbeParam = string | number | null;

  function probeCte(): { text: string; params: ProbeParam[] } {
    const params: ProbeParam[] = [];
    const tuples = rows.map((row) => {
      const values: ProbeParam[] = [
        row.index,
        locationIdFor(row.level.isSellable),
        fromUlps(row.level.onHand),
        fromUlps(row.level.committed),
        bucketText(row.level.blocked, row.nulled.blocked),
        bucketText(row.level.qualityHold, row.nulled.qualityHold),
        bucketText(row.level.outgoing, row.nulled.outgoing),
        row.level.ownership ?? null,
        tsAnswer(row),
      ];
      const casts = ["int", "int", "numeric", "numeric", "numeric", "numeric", "numeric", "text", "numeric"];
      const placeholders = values.map((value, i) => {
        params.push(value);
        return `$${params.length}::${casts[i]}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    return {
      text: `
        inv_locations(id, is_sellable) AS (
          VALUES (${LOCATION_SELLABLE}::int, true),
                 (${LOCATION_NOT_SELLABLE}::int, false),
                 (${LOCATION_NULL_SELLABLE}::int, NULL::boolean)
        ),
        avail_probe(idx, location_id, on_hand, committed, blocked_qty,
                    quality_hold_qty, outgoing_qty, ownership, ts_answer) AS (
          VALUES ${tuples.join(",\n                 ")}
        )`,
      params,
    };
  }

  it("renders the production expression with no bound parameters of its own", () => {
    const rendered = dialect.sqlToQuery(availableQtySql("avail_probe"));
    expect(rendered.params).toHaveLength(0);
    expect(rendered.sql).toContain("inv_locations");
    expect(rendered.sql).toContain("avail_probe.on_hand");
    expect(rendered.sql).toContain("avail_probe.outgoing_qty");
  });

  it("agrees with the TypeScript formula on every generated row", async () => {
    const cte = probeCte();
    const expression = dialect.sqlToQuery(availableQtySql("avail_probe")).sql;
    const mismatches = await db().unsafe(
      `WITH ${cte.text}
       SELECT * FROM (
         SELECT idx, location_id, on_hand, committed, blocked_qty, quality_hold_qty,
                outgoing_qty, ownership, ts_answer, ${expression} AS pg_answer
         FROM avail_probe
       ) q
       WHERE q.pg_answer IS DISTINCT FROM q.ts_answer
       ORDER BY q.idx
       LIMIT 10`,
      cte.params,
    );
    expect(
      mismatches.map(
        (m) =>
          `row ${m.idx}: sql=${m.pg_answer} ts=${m.ts_answer} ` +
          `(on_hand=${m.on_hand} committed=${m.committed} blocked=${m.blocked_qty} ` +
          `hold=${m.quality_hold_qty} outgoing=${m.outgoing_qty} ` +
          `location=${m.location_id} ownership=${m.ownership})`,
      ),
    ).toEqual([]);
  });

  it("agrees on the aggregate as well as the row, so the SUM wrapper cannot drift alone", async () => {
    const cte = probeCte();
    const expression = dialect.sqlToQuery(availableQtySumSql("avail_probe")).sql;
    const [total] = await db().unsafe(
      `WITH ${cte.text}
       SELECT ${expression} AS pg_total, SUM(ts_answer) AS ts_total FROM avail_probe`,
      cte.params,
    );
    expect(total).toBeDefined();
    expect(Number(total?.pg_total)).toBe(Number(total?.ts_total));
  });

  /**
   * ANTI-VACUITY. Everything above is satisfied by three rows of zeroes, and by
   * a shadow CTE that PostgreSQL quietly ignored. These are the floors.
   */
  it("actually exercised both gates, both null encodings and a positive arithmetic result", async () => {
    const cte = probeCte();
    const expression = dialect.sqlToQuery(availableQtySql("avail_probe")).sql;
    const [counts] = await db().unsafe(
      `WITH ${cte.text},
        answered AS (
          SELECT idx, location_id, ownership, blocked_qty, quality_hold_qty, outgoing_qty,
                 (on_hand - committed - COALESCE(blocked_qty, 0)
                    - COALESCE(quality_hold_qty, 0) - COALESCE(outgoing_qty, 0)) AS arithmetic,
                 ${expression} AS pg_answer
          FROM avail_probe
        )
        SELECT
          count(*) FILTER (WHERE location_id = ${LOCATION_NOT_SELLABLE}
                             AND arithmetic > 0 AND pg_answer = 0) AS gate_withdrew_stock,
          count(*) FILTER (WHERE ownership IS NOT NULL AND ownership <> 'OWNED'
                             AND arithmetic > 0 AND pg_answer = 0) AS ownership_withdrew_stock,
          count(*) FILTER (WHERE ownership IS NULL AND location_id <> ${LOCATION_NOT_SELLABLE}
                             AND pg_answer = arithmetic) AS null_ownership_fell_through,
          count(*) FILTER (WHERE location_id = ${LOCATION_MISSING}
                             AND ownership = 'OWNED' AND pg_answer = arithmetic) AS missing_location_is_sellable,
          count(*) FILTER (WHERE location_id = ${LOCATION_NULL_SELLABLE}
                             AND ownership = 'OWNED' AND pg_answer = arithmetic) AS null_sellable_is_sellable,
          count(*) FILTER (WHERE blocked_qty IS NULL OR quality_hold_qty IS NULL
                             OR outgoing_qty IS NULL) AS null_buckets,
          count(*) FILTER (WHERE arithmetic <> 0) AS non_trivial_arithmetic,
          count(*) AS total
        FROM answered`,
      cte.params,
    );
    const floors: ReadonlyArray<readonly [string, number]> = [
      ["total", ROWS],
      ["gate_withdrew_stock", 10],
      ["ownership_withdrew_stock", 10],
      ["null_ownership_fell_through", 10],
      ["missing_location_is_sellable", 5],
      ["null_sellable_is_sellable", 5],
      ["null_buckets", 100],
      ["non_trivial_arithmetic", 100],
    ];
    const short = floors
      .filter(([key, floor]) => Number(counts?.[key] ?? 0) < floor)
      .map(([key, floor]) => `${key}: ${Number(counts?.[key] ?? 0)} < ${floor}`);
    expect(short.join("; ")).toBe("");
  });
});
