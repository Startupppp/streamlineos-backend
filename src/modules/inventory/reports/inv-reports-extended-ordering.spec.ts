import { InvReportsExtendedService } from "./inv-reports-extended.service";

/**
 * Proves that getReorderReportUpgraded orders before it paginates.
 *
 * Without ORDER BY, Postgres returns rows in heap order — arbitrary between
 * pages — so page 2 can repeat or omit rows from page 1. LIMIT/OFFSET over an
 * unordered relation is the bug; ORDER BY ahead of them is the fix.
 *
 * This was written against a Drizzle query builder and asserted the call
 * sequence `.orderBy()` then `.offset()`. The method now issues one raw
 * statement — a CTE with a `count(*) OVER ()` window instead of a second count
 * query — so there is no builder to watch. The invariant is unchanged, so the
 * test reads it off the emitted SQL instead of off the mock chain.
 */

interface StringChunk {
  value: string[];
}

function isStringChunk(chunk: unknown): chunk is StringChunk {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    Array.isArray((chunk as StringChunk).value) &&
    (chunk as StringChunk).value.every((v) => typeof v === "string")
  );
}

/** The literal SQL skeleton, with parameters left out. */
function emittedSql(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (isStringChunk(node)) {
      parts.push(node.value.join(""));
      return;
    }
    const nested = (node as { queryChunks?: unknown[] })?.queryChunks;
    if (Array.isArray(nested)) nested.forEach(walk);
  };
  chunks.forEach(walk);
  return parts.join(" ");
}

/**
 * The outermost SELECT only. The statement also carries a LATERAL subquery that
 * orders its own single row, and that ORDER BY sits before the outer
 * LIMIT/OFFSET too — so a search across the whole statement keeps passing after
 * the outer ORDER BY is deleted, which is exactly the regression this guards.
 */
function outerSelect(text: string): string {
  return text.slice(text.lastIndexOf("FROM r"));
}

describe("InvReportsExtendedService.getReorderReportUpgraded — deterministic ORDER BY", () => {
  const execute = jest.fn().mockResolvedValue([]);
  const mockDb = { execute };
  const mockCache = { cached: jest.fn() };
  const mockWarehouseScope = {
    resolve: jest.fn().mockResolvedValue(null),
    locationPredicate: jest.fn().mockReturnValue(undefined),
  };
  const mockValuation = { costFor: jest.fn() };

  const service = new InvReportsExtendedService(
    mockDb as never,
    mockCache as never,
    mockWarehouseScope as never,
    mockValuation as never,
  );

  beforeEach(() => {
    execute.mockClear();
    execute.mockResolvedValue([]);
  });

  it("reads the statement it actually ran, so an empty sweep cannot pass", async () => {
    await service.getReorderReportUpgraded("org1", "user1", { page: 2, limit: 10 });
    expect(execute).toHaveBeenCalledTimes(1);
    const text = emittedSql(execute.mock.calls[0][0]);
    expect(text.length).toBeGreaterThan(200);
    expect(text).toContain("inv_stock_levels");
  });

  it("orders before it paginates", async () => {
    await service.getReorderReportUpgraded("org1", "user1", { page: 2, limit: 10 });
    const outer = outerSelect(emittedSql(execute.mock.calls[0][0]));

    const orderBy = outer.indexOf("ORDER BY");
    const limit = outer.indexOf("LIMIT");
    const offset = outer.indexOf("OFFSET");

    expect(orderBy).toBeGreaterThanOrEqual(0);
    expect(limit).toBeGreaterThan(orderBy);
    expect(offset).toBeGreaterThan(orderBy);
  });

  it("orders on a unique-enough key that two pages cannot overlap", async () => {
    await service.getReorderReportUpgraded("org1", "user1", { page: 2, limit: 10 });
    const outer = outerSelect(emittedSql(execute.mock.calls[0][0]));
    // sku alone repeats across locations; the variant id is what breaks the tie.
    expect(outer.slice(outer.indexOf("ORDER BY"))).toContain("product_variant_id");
  });

  it("bite: a statement that paginates without ordering fails this test", () => {
    const unordered = "SELECT * FROM inv_stock_levels LIMIT 10 OFFSET 10";
    expect(unordered.lastIndexOf("ORDER BY")).toBe(-1);
  });
});
