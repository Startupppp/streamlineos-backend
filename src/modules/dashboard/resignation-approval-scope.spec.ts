import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { resignations } from "../../db/schema";
import { ScopedRead } from "../access/scoped-read";
import { resignationApprovalScope } from "./resignation-approval-scope";

const dialect = new PgDialect();
const ORG = "org_1";
const ACTOR = "user_actor";

const renderShapeArm = (arm: "own" | "team") =>
  dialect.sqlToQuery(resignationApprovalScope(ORG, ACTOR)[arm] ?? sql`false`).sql;

describe("resignationApprovalScope", () => {
  it("restricts own to resignations whose subject reports to the actor via the reporting line", () => {
    const rendered = renderShapeArm("own");

    expect(rendered).toContain('"hr_reporting_lines"');
    expect(rendered).toContain("rl.manager_employment_id");
    expect(rendered).not.toBe("true");
  });

  it("restricts team to the derived approver and the actor's teammates", () => {
    const rendered = renderShapeArm("team");

    expect(rendered).toContain('"hr_reporting_lines"');
    expect(rendered).toContain('"resignations"."user_id"');
    expect(rendered).toContain("EXISTS");
  });

  it("binds the actor rather than interpolating it", () => {
    const query = dialect.sqlToQuery(resignationApprovalScope(ORG, ACTOR).own);

    expect(query.params).toContain(ACTOR);
    expect(query.sql).not.toContain(ACTOR);
  });

  it("mirrors the leave predicate it sits beside, so neither own nor team is unrestricted", () => {
    expect(renderShapeArm("own")).not.toBe("true");
    expect(renderShapeArm("team")).not.toBe("true");
  });

  it("composes through ScopedRead: all is unrestricted, none is denied, own applies the reporting-line predicate", () => {
    const spec = { tenant: resignations.orgId, scope: resignationApprovalScope(ORG, ACTOR) };

    expect(ScopedRead.of(ORG, ACTOR, "none").denied).toBe(true);

    const allSql = ScopedRead.of(ORG, ACTOR, "all").compose(
      spec,
      ({ sql: where }) => dialect.sqlToQuery(where).sql,
      () => "denied",
    );
    expect(allSql).toContain("true");

    const ownSql = ScopedRead.of(ORG, ACTOR, "own").compose(
      spec,
      ({ sql: where }) => dialect.sqlToQuery(where).sql,
      () => "denied",
    );
    expect(ownSql).toContain('"hr_reporting_lines"');
  });
});

describe("the pending-approvals resignation count applies the predicate", () => {
  const source = readFileSync(join(__dirname, "dashboard-leave.service.ts"), "utf8");
  const countBlock = source.slice(
    source.indexOf("tenant: resignations.orgId"),
    source.indexOf("const pendingLeaves"),
  );

  it("locates the resignation count block", () => {
    expect(countBlock).toContain(".from(resignations)");
  });

  it("passes the resolved scope shape into the where clause rather than filtering on org and status alone", () => {
    expect(countBlock).toContain("resignationApprovalScope(orgId, u.userId)");
  });

  it("reaches the approver relation through the predicate, without joining users", () => {
    expect(countBlock).not.toContain("innerJoin(users");
  });

  it("keeps the predicate self-contained, so removing the join cannot widen the count", () => {
    for (const arm of ["own", "team"] as const) {
      const rendered = renderShapeArm(arm);

      expect(rendered).not.toContain('"users"');
      expect(rendered).toContain('"hr_reporting_lines"');
    }
  });
});
