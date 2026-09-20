import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  assignedOrParticipatingIds,
  mineCountSql,
  resolveWorkSort,
} from "./work-scope-union";

const dialect = new PgDialect();

function render(value: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]);
  return { sql: query.sql, params: query.params };
}

const ACTOR = { orgId: "org-1", userId: "user-7" };

function idQuery() {
  const sort = resolveWorkSort("rank");
  return render(
    assignedOrParticipatingIds({
      ...ACTOR,
      baseWhere: sql`true`,
      carry: sort.carry,
      orderBy: sort.unionOrderBy,
      limit: 101,
    }),
  );
}

describe("GET /build/all-work?scope=mine — the personal list is bound to the actor", () => {
  it("restricts the assignee branch to the caller's own membership", () => {
    const { sql: text, params } = idQuery();
    expect(text).toContain("assignee_membership_id");
    expect(text).toContain("organization_members");
    expect(params).toContain(ACTOR.userId);
  });

  it("adds a participation branch, so a ticket shared through ticket_assignees is not lost", () => {
    const { sql: text } = idQuery();
    expect(text).toContain("ticket_assignees");
    expect(text).toContain("UNION");
  });

  it("binds the actor on both branches, so neither half can widen to the whole organisation", () => {
    const { sql: text } = idQuery();
    const userIdBindings = text.split("user_id =").length - 1;
    expect(userIdBindings).toBe(2);
  });

  it("counts the same two branches it pages, so the total cannot exceed the rows", () => {
    const { sql: text, params } = render(mineCountSql(sql`true`, ACTOR.orgId, ACTOR.userId));
    expect(text).toContain("count(*)");
    expect(text.split("user_id =").length - 1).toBe(2);
    expect(params).toContain(ACTOR.userId);
  });

  it("binds the caller's own id as a parameter on each branch rather than inlining a constant", () => {
    const { params } = idQuery();
    const actorBindings = params.filter((param) => param === ACTOR.userId).length;
    expect(actorBindings).toBe(2);
  });
});
