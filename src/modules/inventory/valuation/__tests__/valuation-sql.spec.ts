import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  asAtValuationSql,
  consumptionEvidenceSql,
  layerEvidenceSql,
  liveValuationSql,
} from "../lib/valuation-sql";

const dialect = new PgDialect();
const render = (statement: SQL) => dialect.sqlToQuery(statement);

const params = {
  orgId: "org-1",
  locationScope: () => sql`TRUE`,
  asOfDate: "2026-08-31",
  limit: 50,
  offset: 0,
};

describe("valuation SQL", () => {
  it("hands every quantity and every cost out as text", () => {
    const query = render(liveValuationSql(params));

    expect(query.sql).toMatch(/on_hand::text\s+AS "onHand"/);
    expect(query.sql).toMatch(/value::text\s+AS "value"/);
    expect(query.sql).not.toContain("float8");
  });

  /**
   * The defect this replaces. `AVG(NULLIF(average_cost, 0))` is the unweighted
   * mean of each location's own average cost; multiplying total on-hand by it is
   * not a weighted average of anything, and it drifts further the more unevenly
   * the same variant is spread across locations.
   */
  it("weights the average by quantity instead of averaging the averages", () => {
    const query = render(liveValuationSql(params));

    expect(query.sql).toContain("SUM(sl.on_hand::numeric * COALESCE(sl.average_cost, 0)::numeric)");
    expect(query.sql).not.toContain("AVG(");
  });

  it("dispatches value on the product's own costing method", () => {
    const query = render(liveValuationSql(params));

    expect(query.sql).toContain("WHEN 'FIFO'");
    expect(query.sql).toContain("WHEN 'STANDARD'");
  });

  /**
   * A page total that is the sum of one page is not the report's total, and two
   * pages of the same report used to add up to less than the report.
   */
  it("totals the whole filtered set, not the page", () => {
    const query = render(liveValuationSql(params));

    expect(query.sql).toContain('SUM(r.value) OVER ()::text');
    expect(query.sql).toContain('count(*) OVER ()::int');
  });

  it("replays a past date from the consumption ledger rather than the projection", () => {
    const query = render(asAtValuationSql(params));

    expect(query.sql).toContain("inv_valuation_consumptions");
    expect(query.sql).toContain("inv_stock_transactions");
    expect(query.sql).toContain("inv_average_cost_history");
    // The stock projection holds one number — today's — so it cannot answer for
    // a past date and is deliberately not read here.
    expect(query.sql).not.toContain("inv_stock_levels");
  });

  it("floors a replayed layer at zero rather than letting it go negative", () => {
    const query = render(asAtValuationSql(params));

    expect(query.sql).toMatch(/GREATEST\(vl\.quantity::numeric - COALESCE\(c\.consumed, 0\), 0\)/);
  });

  it("binds the as-at date on both halves of the replay", () => {
    const query = render(asAtValuationSql(params));

    expect(query.params.filter((p) => p === "2026-08-31").length).toBeGreaterThanOrEqual(3);
  });

  it("shows a layer's remaining quantity as at the quoted date, and what drew it down", () => {
    const query = render(layerEvidenceSql("org-1", 7, () => sql`TRUE`, "2026-08-31", undefined, 50, 0));

    expect(query.sql).toMatch(/AS "remainingQuantityAsAt"/);
    expect(query.sql).toMatch(/AS "consumedQuantity"/);
    expect(query.sql).toMatch(/AS "consumptionCount"/);
    expect(query.sql).toContain("inv_valuation_consumptions");
    expect(query.params).toContain(7);
  });

  it("cites the layer on every consumption line", () => {
    const query = render(consumptionEvidenceSql("org-1", sql`TRUE`, () => sql`TRUE`, 50, 0));

    expect(query.sql).toMatch(/vl\.unit_cost::text\s+AS "layerUnitCost"/);
    expect(query.sql).toMatch(/vc\.valuation_layer_id\s+AS "valuationLayerId"/);
    expect(query.sql).toMatch(/vc\.quantity::text\s+AS "quantity"/);
    expect(query.sql).toContain("JOIN inv_valuation_layers vl");
    expect(query.sql).toContain("JOIN inv_stock_transactions t");
  });

  it("narrows to one warehouse without dropping the caller's own scope", () => {
    const query = render(liveValuationSql({ ...params, warehouseId: 3 }));

    expect(query.sql).toContain("inv_locations");
    expect(query.params).toContain(3);
  });

  it("binds the page rather than inlining it", () => {
    const query = render(liveValuationSql({ ...params, limit: 25, offset: 75 }));

    expect(query.params).toContain(25);
    expect(query.params).toContain(75);
  });
});
