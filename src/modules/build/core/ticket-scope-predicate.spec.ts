import { PgDialect } from "drizzle-orm/pg-core";
import { ticketScopePredicate } from "./tickets-scope";

describe("canonical ticket read scope predicate", () => {
  const dialect = new PgDialect();

  it("denies absent permissions even for a historical assignee", () => {
    const predicate = ticketScopePredicate("none", "tenant", "actor");
    if (!predicate) throw new Error("none must produce a denying SQL predicate");
    expect(dialect.sqlToQuery(predicate).sql).toBe("false");
  });

  it.each(["own", "team"] as const)("%s scope uses tenant-scoped assignment and reporter edges", (scope) => {
    const predicate = ticketScopePredicate(scope, "tenant-a", "actor-b");
    if (!predicate) throw new Error("Restricted scope must produce a SQL predicate");
    const query = dialect.sqlToQuery(predicate);
    expect(query.params).toContain("tenant-a");
    expect(query.params).toContain("actor-b");
    expect(query.sql).toContain("assignee_membership_id");
    expect(query.sql).toContain("reporter_id");
    expect(query.sql).toContain("om.org_id = ta.org_id");
    expect(query.sql).toContain("ta.ticket_id");
  });

  it("does not add a restriction to a verified all scope", () => {
    expect(ticketScopePredicate("all", "tenant", "actor")).toBeUndefined();
  });
});
