import { PgDialect } from "drizzle-orm/pg-core";
import { clientAccounts } from "../../db/schema";
import { ScopedRead, type ScopedWhere } from "../access/scoped-read";
import { CLIENT_ACCOUNTS_SCOPE } from "./client-accounts-scope";

const dialect = new PgDialect();
const SPEC = { tenant: clientAccounts.orgId, scope: CLIENT_ACCOUNTS_SCOPE };
const clauseFor = (scope: "all" | "team" | "own" | "none"): ScopedWhere | null =>
  ScopedRead.of("org-a", "user-abc", scope).compose(SPEC, (where) => where, () => null);
const render = (scope: "all" | "team" | "own" | "none") => {
  const where = clauseFor(scope);
  return where === null ? null : dialect.sqlToQuery(where.sql).sql;
};

describe("the client-accounts scoped read", () => {
  it("never reaches a clause for none, so the query is not built", () => {
    expect(clauseFor("none")).toBeNull();
  });

  it("carries the tenant predicate for every scope that does reach the database", () => {
    for (const scope of ["all", "team", "own"] as const)
      expect(render(scope)).toContain("org_id");
  });

  it("does not widen all past the tenant predicate", () => {
    expect(render("all")).not.toContain("sales_rep_id");
  });

  it("does not widen team to every row", () => {
    expect(render("team")).toContain("sales_rep_id");
  });

  it("does not widen own to every row", () => {
    expect(render("own")).toContain("sales_rep_id");
  });

  it("binds the acting user, not an arbitrary one", () => {
    const where = ScopedRead.of("org-a", "user-xyz", "own").compose(SPEC, (w) => w, () => null);
    expect(dialect.sqlToQuery((where as ScopedWhere).sql).params).toContain("user-xyz");
  });
});
