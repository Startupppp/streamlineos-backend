import { PgDialect } from "drizzle-orm/pg-core";
import { committedGrainPredicate } from "../reservation.service";
import { dbSpecClient, dbSpecSuite, dbSpecUrl } from "../../../../test/db-spec-gate";

/**
 * INV-40 — the grain a reservation promises against, differentially tested.
 *
 * `inv_stock_levels` has a six-column natural key and this module has now
 * forgotten two of its components on this path. Both times the shape was the
 * same: the increment found one row and the release matched a predicate that
 * was one column shorter, so it decremented rows the reservation had never
 * touched. `GREATEST(0, committed - n)` clamps the result, so the
 * over-subtraction leaves no negative number behind and no error — the stock
 * simply reads as available again and can be promised to a second customer.
 *
 * The first miss was `lot_id`. The second was `ownership`, and it was worse,
 * because ownership is a gate rather than a term: the SELECT that chose the row
 * did not filter on it either, and did not project it, so `availableQty` — which
 * treats an absent `ownership` as "this caller has not been taught about
 * consignment" — computed a consigned row as if the goods were ours. A
 * supplier's stock could be reserved and sold.
 *
 * A test that re-wrote the predicate would only prove the copy. This renders
 * the real `committedGrainPredicate` with drizzle's own dialect — the same text
 * the service sends — and runs it against real rows that differ in exactly one
 * key column at a time.
 *
 * Run with:
 *   DATABASE_URL=postgres://... pnpm test:db --testPathPattern=reservation-grain
 */

const SUITE = dbSpecSuite();

/** Negative ids so the probe cannot collide with a real row. */
const ORG = "dbspec-reservation-grain";
const VARIANT = -9101;
const LOCATION = -9102;

interface ProbeRow {
  readonly label: string;
  readonly lot: number | null;
  readonly serial: number | null;
  readonly hu: number | null;
  readonly ownership: "OWNED" | "VENDOR" | "CUSTOMER";
}

/**
 * One row per way of differing from the target by a single key column.
 *
 * Every row but the first is a row the release must NOT touch, and each one is
 * a bug this module has had or could have: the lot row is the first miss, the
 * consigned row is the second, and the handling-unit row is NEO-4's.
 */
const ROWS: readonly ProbeRow[] = [
  { label: "target", lot: null, serial: null, hu: null, ownership: "OWNED" },
  { label: "same bin, a lot", lot: 77, serial: null, hu: null, ownership: "OWNED" },
  { label: "same bin, a serial", lot: null, serial: 88, hu: null, ownership: "OWNED" },
  { label: "same bin, a pallet", lot: null, serial: null, hu: 99, ownership: "OWNED" },
  { label: "same bin, consigned", lot: null, serial: null, hu: null, ownership: "VENDOR" },
  { label: "same bin, customer-owned", lot: null, serial: null, hu: null, ownership: "CUSTOMER" },
];

SUITE("INV-40 — the reservation grain predicate matches one row and no other", () => {
  const dialect = new PgDialect();
  let sql: ReturnType<typeof dbSpecClient> | null = null;

  beforeAll(async () => {
    sql = dbSpecClient(dbSpecUrl());

    /**
     * A shadow table rather than the real one: this proves a predicate, and it
     * must not depend on an organisation existing, on RLS context, or on
     * anything another suite might have left behind.
     */
    await sql`DROP TABLE IF EXISTS reservation_grain_probe`;
    await sql`
      CREATE TABLE reservation_grain_probe (
        id serial PRIMARY KEY,
        label text NOT NULL,
        org_id text NOT NULL,
        product_variant_id integer NOT NULL,
        location_id integer NOT NULL,
        lot_id integer,
        serial_id integer,
        handling_unit_id integer,
        ownership text NOT NULL,
        committed numeric NOT NULL DEFAULT 0
      )
    `;

    for (const row of ROWS) {
      await sql`
        INSERT INTO reservation_grain_probe
          (label, org_id, product_variant_id, location_id, lot_id, serial_id, handling_unit_id, ownership, committed)
        VALUES (${row.label}, ${ORG}, ${VARIANT}, ${LOCATION},
                ${row.lot}, ${row.serial}, ${row.hu}, ${row.ownership}, 10)
      `;
    }
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`DROP TABLE IF EXISTS reservation_grain_probe`;
    await sql.end({ timeout: 5 });
  }, 30_000);

  const rendered = () =>
    dialect.sqlToQuery(
      committedGrainPredicate(ORG, {
        productVariantId: VARIANT,
        locationId: LOCATION,
        lotId: null,
        serialId: null,
        handlingUnitId: null,
      }),
    );

  it("selects the loose, owned row and nothing else at the same bin", async () => {
    const client = sql;
    if (!client) throw new Error("no client");
    const query = rendered();

    const matched = await client.unsafe(
      `SELECT label FROM reservation_grain_probe WHERE ${query.sql} ORDER BY label`,
      query.params as never[],
    );

    const labels = (matched as unknown as { label: string }[]).map((r) => r.label);
    expect(labels).toEqual(["target"]);
  });

  /**
   * The failure as the product would have seen it. Ten units are committed on
   * every row; the release takes ten off the grain it was given. Any row other
   * than the target dropping to zero is stock this reservation never held being
   * handed back to whoever asks next.
   */
  it("decrements only the row the reservation incremented", async () => {
    const client = sql;
    if (!client) throw new Error("no client");
    const query = rendered();

    await client.unsafe(
      `UPDATE reservation_grain_probe
          SET committed = GREATEST(0, committed - 10::numeric)
        WHERE ${query.sql}`,
      query.params as never[],
    );

    const after = await client.unsafe(
      `SELECT label, committed::text AS committed FROM reservation_grain_probe ORDER BY label`,
    );

    const byLabel = Object.fromEntries(
      (after as unknown as { label: string; committed: string }[]).map((r) => [
        r.label,
        r.committed,
      ]),
    );

    expect(byLabel["target"]).toBe("0");
    for (const row of ROWS.filter((r) => r.label !== "target"))
      expect({ [row.label]: byLabel[row.label] }).toEqual({ [row.label]: "10" });
  });

  /**
   * The anti-vacuity floor. If the predicate stopped matching anything — a
   * renamed column, a rendering change — both assertions above would still
   * pass, because "no rows touched" satisfies "no wrong rows touched".
   */
  it("actually matched something, so the assertions above mean something", async () => {
    const client = sql;
    if (!client) throw new Error("no client");
    const query = rendered();

    const [{ count }] = (await client.unsafe(
      `SELECT count(*)::int AS count FROM reservation_grain_probe WHERE ${query.sql}`,
      query.params as never[],
    )) as unknown as { count: number }[];

    expect(count).toBe(1);
  });
});
