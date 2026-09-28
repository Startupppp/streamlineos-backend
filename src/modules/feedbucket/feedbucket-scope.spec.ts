import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { feedbucketSubmissions } from "../../db/schema";
import { ScopedRead } from "../access/scoped-read";
import { feedbucketScope } from "./feedbucket-scope";

const dialect = new PgDialect();

function renderArm(userId: string, membershipId: number | null, arm: "own" | "team"): string {
  const shape = feedbucketScope(userId, membershipId);
  const sqlValue = shape[arm] as SQL;
  return dialect.sqlToQuery(sqlValue).sql;
}

describe("feedbucketScope", () => {
  const userId = "user-abc";

  it("own arm denies when there is no membership to bind", () => {
    expect(renderArm(userId, null, "own")).toBe("false");
  });

  it("own arm matches the caller's membership id, not the user id", () => {
    const shape = feedbucketScope(userId, 42);
    const query = dialect.sqlToQuery(shape.own as SQL);
    expect(query.sql).toContain('"assignee_membership_id"');
    expect(query.params).toContain(42);
    expect(query.params).not.toContain(userId);
  });

  it("team arm uses the caller's membership id when present", () => {
    const query = dialect.sqlToQuery(feedbucketScope(userId, 42).team as SQL);
    expect(query.sql).toContain('"assignee_membership_id"');
    expect(query.params).toContain(42);
    expect(query.params).not.toContain(userId);
  });

  it("team arm denies when the caller has no membership to bind", () => {
    expect(renderArm(userId, null, "team")).toBe("false");
  });

  it("composes through ScopedRead: all is unrestricted, none is denied", () => {
    const ORG = "org-a";
    const spec = { tenant: feedbucketSubmissions.orgId, scope: feedbucketScope(userId, null) };
    expect(ScopedRead.of(ORG, userId, "none").denied).toBe(true);

    const allSql = ScopedRead.of(ORG, userId, "all").compose(
      spec,
      ({ sql: where }) => dialect.sqlToQuery(where).sql,
      () => "denied",
    );
    expect(allSql).toContain("true");
  });
});
