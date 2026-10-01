import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ScopedRead } from "../../../access/scoped-read";
import {
  projectReachFor,
  projectReachSql,
  projectRelationship,
  reachableProjectsSql,
  reachableTicketProjectsSql,
  ticketProjectReachableSql,
  ticketVisibleSql,
} from "./project-relationship";

const ORG_ID = "org-reach-test";
const MEMBERSHIP_ID = 99;
const dialect = new PgDialect();

function render(value: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(value);
  return { sql: query.sql.toLowerCase(), params: query.params };
}

const read = (scope: "all" | "own" | "team" | "none") => ScopedRead.of(ORG_ID, "user-1", scope);

describe("projectRelationship — the one membership rule both the list and the per-row decision read", () => {
  const relationship = projectRelationship(ORG_ID, MEMBERSHIP_ID);
  const any = render(reachableProjectsSql(ORG_ID, MEMBERSHIP_ID));

  it("covers the manager, direct-member and team-member branches combined with OR", () => {
    expect(any.sql).toContain("manager_membership_id");
    expect(any.sql).toContain("project_members");
    expect(any.sql).toContain("project_team_assignments");
    expect(any.sql).toContain("project_team_members");
    expect(any.sql).toContain(" or ");
  });

  it("only counts ACTIVE memberships on both subquery branches, so a suspended member reaches nothing", () => {
    expect(any.params.filter((p) => p === "ACTIVE")).toHaveLength(2);
  });

  it("binds orgId and membershipId as parameters, never as literals", () => {
    expect(any.params.filter((p) => p === ORG_ID).length).toBeGreaterThanOrEqual(2);
    expect(any.params.filter((p) => p === MEMBERSHIP_ID).length).toBeGreaterThanOrEqual(3);
    expect(any.sql).not.toContain(ORG_ID);
  });

  it("derives the per-row role from the same direct-member rows the list predicate filters on", () => {
    const role = render(relationship.memberRole);
    expect(role.sql).toContain("project_members");
    expect(role.sql).toContain("organization_members");
    expect(role.params).toEqual(expect.arrayContaining(["ACTIVE", ORG_ID, MEMBERSHIP_ID]));
    expect(render(relationship.onTeam).sql).toContain("project_team_assignments");
  });

  it("keeps the canonical ticket form scoped to reachable projects of the caller's org", () => {
    const ticketForm = render(reachableTicketProjectsSql(ORG_ID, MEMBERSHIP_ID));
    expect(ticketForm.sql).toContain("project_members");
    expect(ticketForm.params).toContain(ORG_ID);
  });

  it("reaches nothing for a principal with no membership rather than matching a NULL manager", () => {
    const none = projectRelationship(ORG_ID, null);
    expect(render(reachableProjectsSql(ORG_ID, null)).sql).toBe("false");
    expect(render(none.manages).sql).toBe("false");
  });
});

describe("projectReachSql — standing decides whether the relationship is consulted at all", () => {
  it("is unconditional for an unrestricted standing, matching the OWNER role of the per-row decision", () => {
    expect(render(projectReachSql(read("all"), ORG_ID, MEMBERSHIP_ID)).sql).toBe("true");
  });

  it("is the relationship rule for an own standing", () => {
    expect(render(projectReachSql(read("own"), ORG_ID, MEMBERSHIP_ID)).sql).toContain("project_members");
  });

  it("reaches nothing for a denied standing even when a relationship exists", () => {
    expect(render(projectReachSql(read("none"), ORG_ID, MEMBERSHIP_ID)).sql).toBe("false");
  });

  it("projectReachFor treats build:manage at all as unrestricted and otherwise falls to the relationship", () => {
    const admin = projectReachFor((key) => read(key === "build:manage" ? "all" : "none"), ORG_ID, MEMBERSHIP_ID);
    const viewer = projectReachFor((key) => read(key === "build:view" ? "own" : "none"), ORG_ID, MEMBERSHIP_ID);
    const nobody = projectReachFor(() => read("none"), ORG_ID, MEMBERSHIP_ID);
    expect(render(admin).sql).toBe("true");
    expect(render(viewer).sql).toContain("project_members");
    expect(render(nobody).sql).toBe("false");
  });
});

describe("ticketVisibleSql — a ticket is visible only inside both the ticket scope and a reachable project", () => {
  const reach = reachableProjectsSql(ORG_ID, MEMBERSHIP_ID);

  it("requires the ticket's project to be reachable unless the ticket has no project", () => {
    const visible = render(ticketVisibleSql(read("all"), reach));
    expect(visible.sql).toContain("is null or");
    expect(visible.sql).toContain("project_members");
  });

  it("applies the own ticket scope on top of project reach", () => {
    const visible = render(ticketVisibleSql(read("own"), reach));
    expect(visible.sql).toContain("reporter_id");
    expect(visible.sql).toContain("project_members");
  });

  it("is false when the ticket scope is denied, whatever the project reach", () => {
    expect(render(ticketVisibleSql(read("none"), reach)).sql).toContain("false");
  });

  it("excludes soft-deleted projects unless the caller asks for them", () => {
    expect(render(ticketProjectReachableSql(ORG_ID, reach)).sql).toContain("deleted_at");
    expect(render(ticketProjectReachableSql(ORG_ID, reach, true)).sql).not.toContain("deleted_at");
  });
});
