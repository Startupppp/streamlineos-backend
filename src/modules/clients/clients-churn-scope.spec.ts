import { PgDialect } from "drizzle-orm/pg-core";
import { clientAccounts } from "../../db/schema";
import { ScopedRead, type ScopedWhere } from "../access/scoped-read";
import { CLIENT_ACCOUNTS_SCOPE } from "./client-accounts-scope";

const dialect = new PgDialect();
const SPEC = { tenant: clientAccounts.orgId, scope: CLIENT_ACCOUNTS_SCOPE };
const clauseFor = (scope: "all" | "team" | "own" | "none"): ScopedWhere | null =>
  ScopedRead.of("org-a", "user-churn", scope).compose(SPEC, (where) => where, () => null);

describe("clients churn and renewals aggregates share the account scope", () => {
  it("does not widen team scope to every client account row", () => {
    const where = clauseFor("team");
    expect(dialect.sqlToQuery((where as ScopedWhere).sql).sql).toContain("sales_rep_id");
  });

  it("denies none scope for client account aggregates before the query is built", () => {
    expect(clauseFor("none")).toBeNull();
  });

  it("scopes the aggregate to the caller's tenant", () => {
    const where = clauseFor("all");
    expect(dialect.sqlToQuery((where as ScopedWhere).sql).params).toContain("org-a");
  });
});
