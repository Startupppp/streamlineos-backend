import { PgDialect } from "drizzle-orm/pg-core";
import { resolveWorkSort, type WorkSortKey } from "./work-scope-union";

const dialect = new PgDialect();

function render(fragment: Parameters<PgDialect["sqlToQuery"]>[0]): string {
  return dialect.sqlToQuery(fragment).sql;
}

describe("resolveWorkSort", () => {
  it.each<[WorkSortKey, "asc" | "desc" | undefined, "asc" | "desc"]>([
    ["rank", undefined, "asc"],
    ["rank", "asc", "asc"],
    ["rank", "desc", "asc"],
    ["dueDate", undefined, "asc"],
    ["dueDate", "desc", "desc"],
    ["priority", "desc", "desc"],
    ["created", undefined, "desc"],
    ["created", "asc", "asc"],
    ["updated", undefined, "desc"],
  ])("orderBy=%s orderDir=%s resolves to %s", (orderBy, orderDir, expected) => {
    expect(resolveWorkSort(orderBy, orderDir).dir).toBe(expected);
  });

  it.each<[WorkSortKey, "asc" | "desc" | undefined]>([
    ["rank", "desc"],
    ["dueDate", "desc"],
    ["dueDate", "asc"],
    ["created", undefined],
    ["priority", "desc"],
  ])(
    "keeps the union ORDER BY and the hydration sort in the same direction for %s/%s",
    (orderBy, orderDir) => {
      const sort = resolveWorkSort(orderBy, orderDir);
      const unionDescends = /u\.sort_col\s+DESC/i.test(render(sort.unionOrderBy));
      const leading = sort.rows[0];
      if (!leading) throw new Error("expected a leading sort expression");
      const hydrationDescends = / desc$/i.test(render(leading).trim());
      expect(unionDescends).toBe(hydrationDescends);
      expect(unionDescends).toBe(sort.dir === "desc");
    },
  );

  it("carries the sort column into the union under the alias the ORDER BY reads", () => {
    const sort = resolveWorkSort("dueDate", "desc");
    expect(render(sort.carry)).toContain("sort_col");
    expect(render(sort.carry)).toContain("created_at");
    expect(render(sort.unionOrderBy)).toContain("u.sort_col");
    expect(render(sort.unionOrderBy)).toContain("u.created_at");
  });

  it("always ends on a unique tiebreaker so offset pagination is stable", () => {
    for (const orderBy of ["rank", "dueDate", "priority", "created", "updated"] as WorkSortKey[]) {
      const sort = resolveWorkSort(orderBy);
      const last = sort.rows[sort.rows.length - 1];
      if (!last) throw new Error("expected a trailing sort expression");
      expect(render(last)).toContain('"id"');
      expect(render(sort.unionOrderBy)).toContain("u.id ASC");
    }
  });
});
