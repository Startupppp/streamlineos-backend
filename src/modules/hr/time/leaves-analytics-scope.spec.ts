import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { leaveApprovalScope } from "./leaves-scope";
import { ScopedRead } from "../../access/scoped-read";
import type { DataScope } from "../../access/access.types";
import { leaveRequests } from "../../../db/schema";

const dialect = new PgDialect();
const render = (scope: DataScope) => {
  const read = ScopedRead.of("org-1", "actor-1", scope);
  const where = read.compose(
    { tenant: leaveRequests.orgId, scope: leaveApprovalScope(1) },
    ({ sql: whereSql }) => whereSql,
    () => sql`false`,
  );
  return dialect.sqlToQuery(where).sql;
};

// c25-02: analytics resolved the caller's scope, refused only "none", then aggregated the whole organisation
describe("leaveApprovalScope, the predicate leave analytics must apply", () => {
  const cases: DataScope[] = ["all", "team", "own", "none"];

  it.each(cases)("renders a predicate for %s", (scope) => {
    expect(render(scope)).toBeTruthy();
  });

  it("does not narrow an all-scoped approver to a particular membership", () => {
    expect(render("all")).not.toContain("approver_membership_id");
  });

  it("denies a none-scoped caller in SQL, not only at the guard", () => {
    expect(render("none")).toContain("false");
  });

  it("narrows an own-scoped approver to requests they approve", () => {
    const rendered = render("own");
    expect(rendered).toContain("approver_membership_id");
    expect(rendered).not.toContain('"approver_id"');
  });

  it("narrows a team-scoped approver, and still requires them as approver", () => {
    const rendered = render("team");
    expect(rendered).toContain("approver_membership_id");
  });

  // The bug was not a missing predicate, it was a predicate that never reached the query
  it("distinguishes own from all, which is the whole defect", () => {
    expect(render("own")).not.toBe(render("all"));
  });
});
