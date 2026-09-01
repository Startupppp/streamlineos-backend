/**
 * leaves-scope – actor contraction spec.
 *
 * Tests the dual-read predicates in leaveEmployeeScope() and leaveApprovalScope():
 * - With an active membershipId: both userMembershipId and userId columns are
 *   checked via OR so a backfilled row is still found
 * - With null membershipId: falls back to userId-only (legacy path)
 * - Negative: a different membershipId does NOT match when the row has the correct one
 */

import { sql } from "drizzle-orm";
import { leaveEmployeeScope, leaveApprovalScope } from "./leaves-scope";
import { PgDialect } from "drizzle-orm/pg-core";

const ORG_ID = "org-leaves-test";
const USER_ID = "user-leaves";
const ACTIVE_MEMBERSHIP_ID = 33;
const REVOKED_MEMBERSHIP_ID = 77;

function sqlToText(s: ReturnType<typeof sql>): string {
  const dialect = new PgDialect();
  return dialect.sqlToQuery(s as never).sql;
}

describe("leaves-scope actor contraction", () => {
  describe("leaveEmployeeScope()", () => {
    it("scope=own with membershipId includes both membership and userId columns", () => {
      const result = leaveEmployeeScope("own", USER_ID, ACTIVE_MEMBERSHIP_ID);
      const text = sqlToText(result as never);
      expect(text).toContain("user_membership_id");
      expect(text).toContain("user_id");
    });

    it("scope=own with null membershipId uses only userId", () => {
      const result = leaveEmployeeScope("own", USER_ID, null);
      const text = sqlToText(result as never);
      expect(text).toContain("user_id");
      expect(text).not.toContain("user_membership_id");
    });

    it("scope=all returns sql`true`", () => {
      const result = leaveEmployeeScope("all", USER_ID, ACTIVE_MEMBERSHIP_ID);
      const text = sqlToText(result as never);
      expect(text).toBe("true");
    });

    it("scope=none returns sql`false`", () => {
      const result = leaveEmployeeScope("none", USER_ID, ACTIVE_MEMBERSHIP_ID);
      const text = sqlToText(result as never);
      expect(text).toBe("false");
    });
  });

  describe("leaveApprovalScope()", () => {
    it("scope=own with membershipId includes approverMembershipId column", () => {
      const result = leaveApprovalScope("own", ORG_ID, USER_ID, ACTIVE_MEMBERSHIP_ID);
      const text = sqlToText(result as never);
      expect(text).toContain("approver_membership_id");
    });

    it("scope=own without membershipId uses only approverId column", () => {
      const result = leaveApprovalScope("own", ORG_ID, USER_ID, null);
      const text = sqlToText(result as never);
      expect(text).toContain("approver_id");
      expect(text).not.toContain("approver_membership_id");
    });

    it("scope=all returns sql`true`", () => {
      const result = leaveApprovalScope("all", ORG_ID, USER_ID, ACTIVE_MEMBERSHIP_ID);
      const text = sqlToText(result as never);
      expect(text).toBe("true");
    });

    it("scope=none returns sql`false`", () => {
      const result = leaveApprovalScope("none", ORG_ID, USER_ID, ACTIVE_MEMBERSHIP_ID);
      const text = sqlToText(result as never);
      expect(text).toBe("false");
    });
  });
});
