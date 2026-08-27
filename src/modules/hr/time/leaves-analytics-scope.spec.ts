import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { leaveApprovalScope } from "./leaves-scope";
import type { DataScope } from "../../access/access.types";

const dialect = new PgDialect();
const render = (predicate: SQL) => dialect.sqlToQuery(predicate).sql;

/**
 * c25-02: analytics resolved the caller's scope, refused only "none", then
 * aggregated the whole organisation. These pin the predicate the fix threads in.
 */
describe("leaveApprovalScope, the predicate leave analytics must apply", () => {
  const cases: DataScope[] = ["all", "team", "own", "none"];

  it.each(cases)("renders a predicate for %s", (scope) => {
    expect(render(leaveApprovalScope(scope, "org-1", "u-1"))).toBeTruthy();
  });

  it("does not narrow an all-scoped approver", () => {
    expect(render(leaveApprovalScope("all", "org-1", "u-1"))).toBe("true");
  });

  it("denies a none-scoped caller in SQL, not only at the guard", () => {
    expect(render(leaveApprovalScope("none", "org-1", "u-1"))).toBe("false");
  });

  it("narrows an own-scoped approver to requests they approve", () => {
    const rendered = render(leaveApprovalScope("own", "org-1", "u-1"));
    expect(rendered).toContain("approver_id");
    expect(rendered).not.toBe("true");
  });

  it("narrows a team-scoped approver, and still requires them as approver", () => {
    const rendered = render(leaveApprovalScope("team", "org-1", "u-1"));
    expect(rendered).toContain("approver_id");
    expect(rendered).not.toBe("true");
  });

  /**
   * The bug was not a missing predicate, it was a predicate that never reached
   * the query. "own" and "all" must not render the same thing.
   */
  it("distinguishes own from all, which is the whole defect", () => {
    expect(render(leaveApprovalScope("own", "org-1", "u-1"))).not.toBe(
      render(leaveApprovalScope("all", "org-1", "u-1")),
    );
  });
});
