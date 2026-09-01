import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { leaveApprovalScope } from "./leaves-scope";
import type { DataScope } from "../../access/access.types";

const dialect = new PgDialect();
const render = (predicate: SQL) => dialect.sqlToQuery(predicate).sql;

// c25-02: analytics resolved the caller's scope, refused only "none", then aggregated the whole organisation
describe("leaveApprovalScope, the predicate leave analytics must apply", () => {
  const cases: DataScope[] = ["all", "team", "own", "none"];

  it.each(cases)("renders a predicate for %s", (scope) => {
    expect(render(leaveApprovalScope(scope, 1))).toBeTruthy();
  });

  it("does not narrow an all-scoped approver", () => {
    expect(render(leaveApprovalScope("all", 1))).toBe("true");
  });

  it("denies a none-scoped caller in SQL, not only at the guard", () => {
    expect(render(leaveApprovalScope("none", 1))).toBe("false");
  });

  it("narrows an own-scoped approver to requests they approve", () => {
    const rendered = render(leaveApprovalScope("own", 1));
    expect(rendered).toContain("approver_membership_id");
    expect(rendered).not.toContain('"approver_id"');
    expect(rendered).not.toBe("true");
  });

  it("narrows a team-scoped approver, and still requires them as approver", () => {
    const rendered = render(leaveApprovalScope("team", 1));
    expect(rendered).toContain("approver_membership_id");
    expect(rendered).not.toBe("true");
  });

  // The bug was not a missing predicate, it was a predicate that never reached the query
  it("distinguishes own from all, which is the whole defect", () => {
    expect(render(leaveApprovalScope("own", 1))).not.toBe(
      render(leaveApprovalScope("all", 1)),
    );
  });
});
