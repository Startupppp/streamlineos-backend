import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { leaveApprovalScope, leaveEmployeeScope } from "./leaves-scope";

const ACTIVE_MEMBERSHIP_ID = 33;
const REVOKED_MEMBERSHIP_ID = 77;

function sqlToText(statement: ReturnType<typeof sql>): string {
  return new PgDialect().sqlToQuery(statement as never).sql;
}

describe("leaves-scope actor contraction", () => {
  it("uses only the canonical subject membership column", () => {
    const text = sqlToText(leaveEmployeeScope("own", ACTIVE_MEMBERSHIP_ID) as never);
    expect(text).toContain("user_membership_id");
    expect(text).not.toContain('"user_id"');
  });

  it("fails closed when a subject membership is unmappable", () => {
    expect(sqlToText(leaveEmployeeScope("own", null) as never)).toBe("false");
  });

  it("uses only the canonical approver membership column", () => {
    const text = sqlToText(leaveApprovalScope("own", ACTIVE_MEMBERSHIP_ID) as never);
    expect(text).toContain("approver_membership_id");
    expect(text).not.toContain('"approver_id"');
  });

  it("fails closed rather than falling back to a legacy approver id", () => {
    expect(sqlToText(leaveApprovalScope("own", null) as never)).toBe("false");
  });

  it("does not substitute an active membership for a revoked membership", () => {
    const query = new PgDialect().sqlToQuery(
      leaveApprovalScope("own", REVOKED_MEMBERSHIP_ID) as never,
    );
    expect(query.params).toEqual([REVOKED_MEMBERSHIP_ID]);
    expect(query.params).not.toContain(ACTIVE_MEMBERSHIP_ID);
  });

  it("retains all and none scope behavior", () => {
    expect(sqlToText(leaveEmployeeScope("all", ACTIVE_MEMBERSHIP_ID) as never)).toBe("true");
    expect(sqlToText(leaveApprovalScope("none", ACTIVE_MEMBERSHIP_ID) as never)).toBe("false");
  });
});
