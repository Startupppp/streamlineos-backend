import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../../db/schema";
import { orgTicketSearchQuery } from "../project-crud/projects-search.service";

/**
 * Ticket search is one bounded, tenant-joined statement.
 *
 * Two defects this pins, both of which a mocked `db` could not see because a mock
 * asserts on the calls the service happens to make rather than on the SQL it emits:
 *
 *  1. Unbounded read. The caller's `project_members` rows were read into an array
 *     with no LIMIT and passed back as `inArray` bind parameters, so one person on
 *     many projects sent an unbounded parameter list per keystroke.
 *  2. Join with no tenant predicate. `projects` was joined on `tickets.project_id =
 *     projects.id` alone. Both are org-local integer keys, so the joined side stated
 *     no org predicate at all and only RLS stood between a search result and another
 *     tenant's project key and name.
 */
function compile(orgId: string, userId: string, q: string, limit: number) {
  const db = drizzle(postgres("postgres://unused:unused@127.0.0.1:1/unused", { max: 1 }), {
    schema,
  });
  return orgTicketSearchQuery(db, orgId, userId, q, limit).toSQL();
}

describe("ProjectsSearchService — cross-tenant isolation and boundedness", () => {
  const ATTACKER_ORG = "org-attacker";
  const compiled = compile(ATTACKER_ORG, "u1", "query", 10);
  const lowered = compiled.sql.toLowerCase();

  it("binds the caller's org and user id as parameters, never as literals", () => {
    expect(compiled.params).toContain(ATTACKER_ORG);
    expect(compiled.params).toContain("u1");
    expect(compiled.sql).not.toContain(ATTACKER_ORG);
    expect(compiled.sql).not.toContain("u1");
  });

  it("resolves project membership with a correlated EXISTS, not a materialised id list", () => {
    expect(lowered).toContain("exists");
    expect(lowered).toContain('"project_members"');
    expect(lowered).toContain('"organization_members"');
    expect(lowered).not.toContain(" in (");
    expect(lowered).not.toContain("= any(");
  });

  it("correlates the membership subquery to the outer ticket row so it cannot be hoisted into an unbounded scan", () => {
    expect(compiled.sql).toMatch(
      /"project_members"\."project_id"\s*=\s*(?:"build"\.)?"tickets"\."project_id"/i,
    );
  });

  it("states an org predicate on the projects join instead of joining on id alone", () => {
    expect(compiled.sql).toMatch(
      /inner join (?:"build"\.)?"projects" on .*"projects"\."org_id"\s*=\s*(?:"build"\.)?"tickets"\."org_id"/is,
    );
  });

  it("caps the ticket read with an explicit limit", () => {
    expect(lowered).toContain("limit");
    expect(compiled.params).toContain(10);
  });

  it("excludes soft-deleted tickets and scopes the outer read to the caller's org", () => {
    expect(lowered).toContain('"tickets"."deleted_at" is null');
    expect(compiled.sql).toMatch(/"tickets"\."org_id"\s*=\s*\$\d+/);
  });

  it("ranks an exact ticket key first, so a key typed in chat resolves past ACP-520..529", () => {
    const exact = compile("org-1", "u1", "ACP-52", 20);
    const orderBy = exact.sql.slice(exact.sql.toLowerCase().lastIndexOf("order by"));
    expect(orderBy).toMatch(/^order by case when upper\(concat\((?:"build"\.)?"projects"\."key", '-', cast\((?:"build"\.)?"tickets"\."ticket_number" as text\)\)\) = upper\(\$\d+\) then 0 else 1 end, (?:"build"\.)?"tickets"\."updated_at" desc/i);
    expect(exact.params).toContain("ACP-52");
  });
});
