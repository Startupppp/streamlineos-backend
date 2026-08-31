import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { resignationApprovalScope } from "./resignation-approval-scope";

const dialect = new PgDialect();
const ORG = "org_1";
const ACTOR = "user_actor";

const toSql = (scope: Parameters<typeof resignationApprovalScope>[0]) =>
  dialect.sqlToQuery(resignationApprovalScope(scope, ORG, ACTOR)).sql;

describe("resignationApprovalScope", () => {
  it("returns an unrestricted predicate only for the all scope", () => {
    expect(toSql("all")).toBe("true");
  });

  it("denies outright for the none scope", () => {
    expect(toSql("none")).toBe("false");
  });

  it("restricts own to resignations whose subject reports to the actor via the reporting line", () => {
    const sql = toSql("own");

    expect(sql).toContain('"hr_reporting_lines"');
    expect(sql).toContain("rl.manager_employment_id");
    expect(sql).not.toBe("true");
  });

  it("restricts team to the derived approver and the actor's teammates", () => {
    const sql = toSql("team");

    expect(sql).toContain('"hr_reporting_lines"');
    expect(sql).toContain('"resignations"."user_id"');
    expect(sql).toContain("EXISTS");
  });

  it("binds the actor rather than interpolating it", () => {
    const query = dialect.sqlToQuery(resignationApprovalScope("own", ORG, ACTOR));

    expect(query.params).toContain(ACTOR);
    expect(query.sql).not.toContain(ACTOR);
  });

  it("mirrors the leave predicate it sits beside, so neither scope is unrestricted below all", () => {
    for (const scope of ["own", "team", "none"] as const) expect(toSql(scope)).not.toBe("true");
  });
});

describe("the pending-approvals resignation count applies the predicate", () => {
  const source = readFileSync(join(__dirname, "dashboard-leave.service.ts"), "utf8");
  const countBlock = source.slice(
    source.indexOf("const [resignationCount]"),
    source.indexOf("const pendingLeaves"),
  );

  it("locates the resignation count block", () => {
    expect(countBlock).toContain(".from(resignations)");
  });

  it("passes the resolved scope into the where clause rather than filtering on org and status alone", () => {
    expect(countBlock).toContain("resignationApprovalScope(scope, orgId, u.userId)");
  });

  it("reaches the approver relation through the predicate, without joining users", () => {
    expect(countBlock).not.toContain("innerJoin(users");
  });

  it("keeps the predicate self-contained, so removing the join cannot widen the count", () => {
    for (const scope of ["own", "team"] as const) {
      const rendered = dialect.sqlToQuery(resignationApprovalScope(scope, ORG, ACTOR)).sql;

      expect(rendered).not.toContain('"users"');
      expect(rendered).toContain('"hr_reporting_lines"');
    }
  });
});
