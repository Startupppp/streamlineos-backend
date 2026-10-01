import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../../db/schema";
import { orgTicketSearchQuery } from "../project-crud/projects-search.service";

const MEMBERSHIP_ID = 42;

function compile(orgId: string, membershipId: number | null, q: string, limit: number) {
  const db = drizzle(postgres("postgres://unused:unused@127.0.0.1:1/unused", { max: 1 }), {
    schema,
  });
  return orgTicketSearchQuery(db, orgId, membershipId, q, limit).toSQL();
}

describe("ProjectsSearchService — cross-tenant isolation and boundedness", () => {
  const ATTACKER_ORG = "org-attacker";
  const compiled = compile(ATTACKER_ORG, MEMBERSHIP_ID, "query", 10);
  const lowered = compiled.sql.toLowerCase();

  it("binds the caller's org_id as a parameter, never as a literal", () => {
    expect(compiled.params).toContain(ATTACKER_ORG);
    expect(compiled.sql).not.toContain(ATTACKER_ORG);
  });

  it("resolves reachability via the canonical three-branch predicate — manager, direct-member, and team branches all appear", () => {
    expect(lowered).toContain("manager_membership_id");
    expect(lowered).toContain("project_members");
    expect(lowered).toContain("project_team_assignments");
    expect(lowered).toContain("organization_members");
    expect(compiled.params).toContain("ACTIVE");
  });

  it("uses IN (SELECT ...) for the canonical reachability predicate so project ids are not materialized in JS", () => {
    expect(lowered).toContain('"tickets"."project_id" in');
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
    const exact = compile("org-1", MEMBERSHIP_ID, "ACP-52", 20);
    const orderBy = exact.sql.slice(exact.sql.toLowerCase().lastIndexOf("order by"));
    expect(orderBy).toMatch(/^order by case when upper\(concat\((?:"build"\.)?"projects"\."key", '-', cast\((?:"build"\.)?"tickets"\."ticket_number" as text\)\)\) = upper\(\$\d+\) then 0 else 1 end, (?:"build"\.)?"tickets"\."updated_at" desc/i);
    expect(exact.params).toContain("ACP-52");
  });

  it("produces sql`false` reachability when membershipId is null so a non-member sees no tickets", () => {
    const nullCompiled = compile(ATTACKER_ORG, null, "x", 10);
    expect(nullCompiled.sql.toLowerCase()).toContain("false");
  });
});
