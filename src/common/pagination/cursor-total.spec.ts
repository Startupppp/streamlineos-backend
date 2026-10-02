import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCursorPage, buildCursorPageWithTotal, type CursorPosition } from "./cursor";

interface Row {
  id: number;
}

const position = (row: Row): CursorPosition => ({
  sortValue: String(row.id),
  id: String(row.id),
});

const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

describe("a cursor page that reports a denominator", () => {
  it("keeps the ordinary page contract: the sentinel row is trimmed and drives hasMore", () => {
    const page = buildCursorPageWithTotal(rows(4), 3, 40, position);

    expect(page.data).toHaveLength(3);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).not.toBeNull();
  });

  it("reports the total it was given rather than the size of the page", () => {
    const page = buildCursorPageWithTotal(rows(4), 3, 40, position);

    expect(page.pagination.total).toBe(40);
    expect(page.pagination.total).not.toBe(page.data.length);
  });

  it("holds the total steady on the last page, where a page-derived count would collapse", () => {
    const first = buildCursorPageWithTotal(rows(4), 3, 40, position);
    const last = buildCursorPageWithTotal(rows(2), 3, 40, position);

    expect(last.pagination.hasMore).toBe(false);
    expect(last.pagination.total).toBe(first.pagination.total);
  });

  it("reports zero as a measured zero, which is what lets a caller tell it apart from absent", () => {
    const page = buildCursorPageWithTotal([], 3, 0, position);

    expect(page.pagination.total).toBe(0);
    expect(page.data).toEqual([]);
  });

  it("leaves the plain helper's shape untouched, so no existing caller starts claiming one", () => {
    const page = buildCursorPage(rows(4), 3, position);

    expect(Object.keys(page.pagination).sort()).toEqual(["hasMore", "limit", "nextCursor"]);
  });
});

describe("the run-exceptions count answers how many match, not how many are left", () => {
  const source = readFileSync(
    join(process.cwd(), "src/modules/payroll/runs/exceptions.service.ts"),
    "utf8",
  );

  it("counts over the filter predicates and never over the cursor position", () => {
    const countQuery = source.slice(
      source.indexOf("const totalQuery"),
      source.indexOf("const rowsQuery"),
    );

    expect(countQuery).toContain("count()");
    expect(countQuery).toContain("and(...filters)");
    expect(countQuery).not.toContain("conditions");
  });

  it("still pages over the filters plus the position, so the two predicate sets stay distinct", () => {
    expect(source).toContain("const conditions = [...filters];");
    expect(source).toMatch(/\.where\(and\(\.\.\.conditions\)\)/);
  });

  it("resolves the count alongside the rows rather than serialising two round trips", () => {
    expect(source).toContain("await Promise.all([rowsQuery, totalQuery])");
  });
});
