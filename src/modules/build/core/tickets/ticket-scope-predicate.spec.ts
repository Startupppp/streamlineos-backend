import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tickets } from "../../../../db/schema";
import { ScopedRead } from "../../../access/scoped-read";
import { ticketScope } from "../lib/tickets-scope";

describe("canonical ticket read scope predicate", () => {
  const dialect = new PgDialect();

  function whereFor(scope: "all" | "own" | "team" | "none", orgId: string, actorId: string) {
    const read = ScopedRead.of(orgId, actorId, scope);
    return read.compose(
      { tenant: tickets.orgId, scope: ticketScope(orgId, actorId) },
      ({ sql: where }) => where,
      () => sql`false`,
    );
  }

  it("denies absent permissions even for a historical assignee", () => {
    const where = whereFor("none", "tenant", "actor");
    expect(dialect.sqlToQuery(where).sql).toBe("false");
  });

  it.each(["own", "team"] as const)("%s scope uses tenant-scoped assignment and reporter edges", (scope) => {
    const where = whereFor(scope, "tenant-a", "actor-b");
    const query = dialect.sqlToQuery(where);
    expect(query.params).toContain("tenant-a");
    expect(query.params).toContain("actor-b");
    expect(query.sql).toContain("assignee_membership_id");
    expect(query.sql).toContain("reporter_id");
    expect(query.sql).toContain("om.org_id = ta.org_id");
    expect(query.sql).toContain("ta.ticket_id");
  });

  it("adds no restriction beyond tenant for a verified all scope", () => {
    const where = whereFor("all", "tenant", "actor");
    const query = dialect.sqlToQuery(where);
    expect(query.sql).not.toContain("assignee_membership_id");
    expect(query.sql).not.toContain("reporter_id");
  });
});
