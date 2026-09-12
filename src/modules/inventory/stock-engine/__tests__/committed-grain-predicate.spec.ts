import { PgDialect } from "drizzle-orm/pg-core";
import { committedGrainPredicate } from "../lib/committed-grain";

/**
 * INV-40, the half that runs without a database.
 *
 * `reservation-grain.db.spec.ts` beside this is the real test: it puts six rows
 * that differ by one key column each into Postgres and proves the predicate
 * matches exactly one. It is also gated on `DATABASE_URL`, so in every
 * environment that does not have one — which is every unit run, and CI until a
 * db job exists — it SKIPS, and the predicate has nothing watching it at all.
 *
 * Measured when `committedGrainPredicate` moved to `lib/committed-grain.ts`:
 * deleting the `ownership = 'OWNED'` line left all 168 suites and 1,760 tests in
 * `src/modules/inventory` green. That is the exact defect the db spec's own
 * header describes as the second and worse of the two misses — a consigned row
 * matching, so a supplier's stock is promised and sold.
 *
 * So this is the floor: render the predicate through drizzle's own dialect, the
 * same text the service sends, and assert every component of the six-column
 * natural key is in it. It cannot replace the differential test — it proves the
 * terms are present, not that they select the right row — and it is not trying
 * to. It is what fails when a term is dropped.
 */
const dialect = new PgDialect();

const render = (alias = "") =>
  dialect.sqlToQuery(
    committedGrainPredicate(
      "org-1",
      {
        productVariantId: 31,
        locationId: 88,
        lotId: null,
        serialId: null,
        handlingUnitId: null,
      },
      alias,
    ),
  );

describe("committedGrainPredicate — the six-column grain, rendered", () => {
  it("constrains every component of the natural key", () => {
    const { sql, params } = render();

    for (const column of [
      "org_id",
      "product_variant_id",
      "location_id",
      "lot_id",
      "serial_id",
      "handling_unit_id",
    ]) {
      expect({ column, constrained: sql.includes(column) }).toEqual({ column, constrained: true });
    }

    // Parameterised, not interpolated — five of the six ride as bind params and
    // `ownership` is the literal below.
    expect(params).toEqual(["org-1", 31, 88, null, null, null]);
  });

  it("keeps ownership as a gate, so consigned stock is never the row that moves", () => {
    // A gate rather than a term: the other five say WHICH row, this one says
    // whose it is. Dropping it lets a release decrement the consigned row
    // standing at the same bin as the owned one, and `GREATEST(0, …)` hides it.
    expect(render().sql).toContain("ownership");
    expect(render().sql).toContain("'OWNED'");
  });

  it("matches NULL grain components rather than comparing to them", () => {
    // `lot_id = NULL` is NULL, never true, so a loose row would match nothing
    // and the release would silently do nothing at all. Three nullable columns,
    // three `IS NOT DISTINCT FROM`.
    const occurrences = render().sql.split("IS NOT DISTINCT FROM").length - 1;
    expect(occurrences).toBe(3);
  });

  it("addresses the columns through the caller's alias when it has one", () => {
    // `createReservationInTx` joins `inv_locations`, so it passes "sl"; the
    // unwind paths update the table unaliased and pass nothing. One predicate
    // has to serve both or the two halves drift, which is the whole argument
    // for it existing.
    expect(render("sl").sql).toContain("sl.product_variant_id");
    expect(render().sql).not.toContain("sl.product_variant_id");
  });
});
