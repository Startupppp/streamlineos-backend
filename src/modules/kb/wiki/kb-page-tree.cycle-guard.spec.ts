import { PgDialect } from "drizzle-orm/pg-core";
import {
  ancestorWalkQuery,
  KB_PAGE_TREE_MAX_ANCESTOR_WALK,
} from "./kb-page-tree.service";

const render = (orgId: string, pageId: number, targetParentId: number) =>
  new PgDialect().sqlToQuery(ancestorWalkQuery(orgId, pageId, targetParentId));

describe("move cycle guard — the ancestor walk is bounded by tree depth rather than by tenant size", () => {
  it("walks upward from the target parent through a recursive CTE instead of selecting every page in the tenant, because the previous form downloaded the whole page graph on every move and that is the read this slice exists to remove", () => {
    const { sql: text } = render("org-1", 5, 9);

    expect(text.toLowerCase()).toContain("with recursive");
    expect(text.toLowerCase()).toContain("join ancestors");
  });

  it("carries no unbounded scan of kb_pages: the only rows the query can reach are the target parent and its ancestor chain, so the plan cannot grow with the number of pages in the tenant", () => {
    const { sql: text } = render("org-1", 5, 9);
    const seedClause = text.slice(0, text.toLowerCase().indexOf("union all"));

    expect(seedClause).toMatch(/where\s+id\s*=/i);
    expect(seedClause.toLowerCase()).not.toContain("union");
  });

  it("caps the recursion depth, so a parent chain corrupted into a loop terminates instead of spinning the database until the statement timeout", () => {
    const { sql: text, params } = render("org-1", 5, 9);

    expect(text.toLowerCase()).toContain("depth <");
    expect(params).toContain(KB_PAGE_TREE_MAX_ANCESTOR_WALK);
  });

  it("binds the tenant on both the seed row and every recursive step, because a recursive step that dropped the tenant could walk into another tenant's parent chain and report a cycle that does not exist for this caller", () => {
    const { sql: text, params } = render("org-77", 5, 9);
    const orgMatches = text.match(/"?org_id"?\s*=/gi) ?? [];

    expect(orgMatches.length).toBeGreaterThanOrEqual(2);
    expect(params).toContain("org-77");
  });

  it("excludes soft-deleted pages on both the seed row and every recursive step, so a deleted page cannot join two live branches into a false cycle", () => {
    const { sql: text } = render("org-1", 5, 9);
    const deletedChecks = text.match(/deleted_at"?\s+is\s+null/gi) ?? [];

    expect(deletedChecks.length).toBeGreaterThanOrEqual(2);
  });

  it("asks only whether the moved page appears in that chain and stops at the first hit, since the move is rejected on existence and counting the chain would be wasted work", () => {
    const { sql: text, params } = render("org-1", 5, 9);

    expect(text.toLowerCase()).toContain("limit");
    expect(params).toContain(5);
  });
});
