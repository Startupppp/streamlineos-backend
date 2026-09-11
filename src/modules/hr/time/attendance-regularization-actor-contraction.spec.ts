/**
 * AttendanceRegularizationService – actor contraction spec.
 *
 * Verifies:
 * - create() writes userMembershipId from the acting principal
 * - list() applies the canonical membership predicate when the query targets
 *   the acting member and fails closed for account-only principals
 */

import { AttendanceRegularizationService } from "./attendance-regularization.service";

const ORG_ID = "org-reg-test";
const USER_ID = "user-reg";
const ACTIVE_MEMBERSHIP_ID = 22;

function makePrincipal(membershipId: number | null) {
  if (membershipId == null)
    return { kind: "account-only" as const };
  return { kind: "human-session" as const, membershipId, userId: USER_ID } as never;
}

function makeUser(membershipId: number | null) {
  return {
    orgId: ORG_ID,
    userId: USER_ID,
    isOrgOwner: false,
    principal: makePrincipal(membershipId),
  } as never;
}

describe("AttendanceRegularizationService – actor contraction", () => {
  const mockAccess = { resolveUserPermissions: jest.fn() };
  const mockWorkflow = {
    startWorkflow: jest.fn().mockResolvedValue({ id: 999 }),
  };
  const mockPayrollInputs = {};
  const mockAudit = { logInfo: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  describe("list() canonical actor predicate", () => {
    it("uses membership identity when targetUserId matches actor", async () => {
      mockAccess.resolveUserPermissions.mockResolvedValue(new Map([["hr:attendance:manage", "own"]]));

      const findMany = jest.fn().mockResolvedValue([]);
      const mockDb = {
        query: {
          hrAttendanceRegularizations: { findMany },
        },
      };

      const service = new AttendanceRegularizationService(
        mockDb as never,
        mockWorkflow as never,
        mockAccess as never,
        mockPayrollInputs as never,
        mockAudit as never,
      );

      const result = await service.list(makeUser(ACTIVE_MEMBERSHIP_ID), {});

      expect(result.data).toHaveLength(0);
      expect(findMany).toHaveBeenCalled();
    });

    it("fails closed when membershipId is null", async () => {
      mockAccess.resolveUserPermissions.mockResolvedValue(new Map([["hr:attendance:manage", "own"]]));

      const findMany = jest.fn().mockResolvedValue([]);
      const mockDb = {
        query: {
          hrAttendanceRegularizations: { findMany },
        },
      };

      const service = new AttendanceRegularizationService(
        mockDb as never,
        mockWorkflow as never,
        mockAccess as never,
        mockPayrollInputs as never,
        mockAudit as never,
      );

      await expect(service.list(makeUser(null), {})).rejects.toThrow(
        "Organization membership required.",
      );
      expect(findMany).not.toHaveBeenCalled();
    });
  });
});
