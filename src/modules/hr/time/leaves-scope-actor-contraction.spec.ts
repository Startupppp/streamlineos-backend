import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { leaveApprovalScope, leaveEmployeeScope } from "./leaves-scope";
import { ScopedRead } from "../../access/scoped-read";
import { leaveRequests } from "../../../db/schema";

const ACTIVE_MEMBERSHIP_ID = 33;
const REVOKED_MEMBERSHIP_ID = 77;

function sqlToText(statement: ReturnType<typeof sql>): string {
  return new PgDialect().sqlToQuery(statement as never).sql;
}

function ownShapeSql(shape: ReturnType<typeof leaveEmployeeScope> | ReturnType<typeof leaveApprovalScope>) {
  if (!("own" in shape)) throw new Error("expected an own-shaped scope");
  return shape.own;
}

describe("leaves-scope actor contraction", () => {
  it("uses only the canonical subject membership column", () => {
    const text = sqlToText(ownShapeSql(leaveEmployeeScope(ACTIVE_MEMBERSHIP_ID)));
    expect(text).toContain("user_membership_id");
    expect(text).not.toContain('"user_id"');
  });

  it("fails closed when a subject membership is unmappable", () => {
    expect(sqlToText(ownShapeSql(leaveEmployeeScope(null)))).toBe("false");
  });

  it("uses only the canonical approver membership column", () => {
    const text = sqlToText(ownShapeSql(leaveApprovalScope(ACTIVE_MEMBERSHIP_ID)));
    expect(text).toContain("approver_membership_id");
    expect(text).not.toContain('"approver_id"');
  });

  it("fails closed rather than falling back to a legacy approver id", () => {
    expect(sqlToText(ownShapeSql(leaveApprovalScope(null)))).toBe("false");
  });

  it("does not substitute an active membership for a revoked membership", () => {
    const query = new PgDialect().sqlToQuery(ownShapeSql(leaveApprovalScope(REVOKED_MEMBERSHIP_ID)));
    expect(query.params).toEqual([REVOKED_MEMBERSHIP_ID]);
    expect(query.params).not.toContain(ACTIVE_MEMBERSHIP_ID);
  });

  it("retains all and none scope behavior end-to-end through ScopedRead", () => {
    const allRead = ScopedRead.of("org-1", "actor-1", "all");
    const allCompiled = new PgDialect().sqlToQuery(
      allRead.compose(
        { tenant: leaveRequests.orgId, scope: leaveEmployeeScope(ACTIVE_MEMBERSHIP_ID) },
        ({ sql: where }) => where,
        () => sql`false`,
      ),
    );
    expect(allCompiled.params).not.toContain(ACTIVE_MEMBERSHIP_ID);

    const noneRead = ScopedRead.of("org-1", "actor-1", "none");
    const noneCompiled = new PgDialect().sqlToQuery(
      noneRead.compose(
        { tenant: leaveRequests.orgId, scope: leaveApprovalScope(ACTIVE_MEMBERSHIP_ID) },
        ({ sql: where }) => where,
        () => sql`false`,
      ),
    );
    expect(noneCompiled.sql).toContain("false");
  });
});
