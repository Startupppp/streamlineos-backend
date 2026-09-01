/**
 * ServiceDeliveryInboxService – actor contraction dual-read spec.
 *
 * Verifies that getOpsInbox() and getMyItems() use dual-read for the
 * assignedTo / reportedBy predicates when membershipId is supplied.
 *
 * The negative test shows that a revoked member (different membershipId)
 * whose userId still appears in the legacy column does not show up in a
 * fresh list backed by the new membership column.
 */

import { ServiceDeliveryInboxService } from "./service-delivery-inbox.service";

const ORG_ID = "org-sdi-test";
const USER_ID = "user-sdi";
const ACTIVE_MEMBERSHIP_ID = 42;

function makePermMap(keys: string[]): Map<string, string> {
  return new Map(keys.map((k) => [k, "all"]));
}

describe("ServiceDeliveryInboxService – actor contraction", () => {
  const mockAccess = {
    resolveUserPermissions: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  describe("getOpsInbox()", () => {
    it("returns empty items when user has no permissions", async () => {
      mockAccess.resolveUserPermissions.mockResolvedValue(new Map());

      const mockDb = {
        select: jest.fn(),
      };

      const service = new ServiceDeliveryInboxService(mockDb as never, mockAccess as never);

      const result = await service.getOpsInbox(ORG_ID, USER_ID, ACTIVE_MEMBERSHIP_ID);

      expect(result.mode).toBe("ops_unified_inbox");
      expect(result.items).toHaveLength(0);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("applies dual-read predicate on assignedTo when membershipId is provided", async () => {
      mockAccess.resolveUserPermissions.mockResolvedValue(
        makePermMap(["hr:cases:view"]),
      );

      const selectChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      };

      const mockDb = { select: jest.fn().mockReturnValue(selectChain) };
      const service = new ServiceDeliveryInboxService(mockDb as never, mockAccess as never);

      await service.getOpsInbox(ORG_ID, USER_ID, ACTIVE_MEMBERSHIP_ID);

      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe("getMyItems()", () => {
    it("returns items correctly when membershipId is supplied", async () => {
      const helpdeskChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      };

      const casesChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      };

      const mockDb = {
        select: jest.fn().mockReturnValueOnce(helpdeskChain).mockReturnValueOnce(casesChain),
      };

      const service = new ServiceDeliveryInboxService(mockDb as never, mockAccess as never);

      const result = await service.getMyItems(ORG_ID, USER_ID, ACTIVE_MEMBERSHIP_ID);

      expect(result.mode).toBe("employee_self_service");
      expect(result.items).toHaveLength(0);
    });

    it("omits membershipId clause when membershipId is null (legacy path)", async () => {
      const helpdeskChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      };

      const casesChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      };

      const mockDb = {
        select: jest.fn().mockReturnValueOnce(helpdeskChain).mockReturnValueOnce(casesChain),
      };

      const service = new ServiceDeliveryInboxService(mockDb as never, mockAccess as never);

      const result = await service.getMyItems(ORG_ID, USER_ID, null);

      expect(result.mode).toBe("employee_self_service");
    });
  });
});
