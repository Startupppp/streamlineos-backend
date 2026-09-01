/**
 * DocumentsService – actor contraction spec.
 *
 * Verifies that documentOwnerPredicate uses the canonical membership identity
 * for the 'own' scope and fails closed for account-only principals.
 *
 * We test the surface of listDocuments() since it exercises the helper directly
 * with no transactional complexity.
 */

import { DocumentsService } from "./documents.service";
import { AuditService } from "../../../common/audit/audit.service";

const ORG_ID = "org-docs-test";
const USER_ID = "user-docs";
const ACTIVE_MEMBERSHIP_ID = 55;

function buildSelectChain(rows: unknown[]) {
  return {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  };
}

describe("DocumentsService – actor contraction dual-read", () => {
  const mockAudit = { logCritical: jest.fn() } as unknown as AuditService;

  describe("listDocuments() with scope='own'", () => {
    it("succeeds with active membershipId (dual-read path)", async () => {
      const mockDb = {
        select: jest.fn().mockReturnValue(buildSelectChain([])),
        query: { documents: { findMany: jest.fn().mockResolvedValue([]) } },
        execute: jest.fn(),
      };

      const service = new DocumentsService(mockDb as never, mockAudit);

      const result = await service.listDocuments(
        ORG_ID,
        USER_ID,
        "own",
        { limit: 20, cursor: undefined, userId: undefined, type: undefined, search: undefined, category: undefined },
        ACTIVE_MEMBERSHIP_ID,
      );

      expect(result.data).toHaveLength(0);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("fails closed without membershipId", async () => {
      const mockDb = {
        select: jest.fn().mockReturnValue(buildSelectChain([])),
        query: { documents: { findMany: jest.fn().mockResolvedValue([]) } },
        execute: jest.fn(),
      };

      const service = new DocumentsService(mockDb as never, mockAudit);

      await expect(service.listDocuments(
        ORG_ID,
        USER_ID,
        "own",
        { limit: 20, cursor: undefined, userId: undefined, type: undefined, search: undefined, category: undefined },
        null,
      )).rejects.toThrow("Organization membership required.");
    });

    it("scope 'all' returns all results regardless of membershipId", async () => {
      const mockDb = {
        select: jest.fn().mockReturnValue(buildSelectChain([])),
        query: { documents: { findMany: jest.fn().mockResolvedValue([]) } },
        execute: jest.fn(),
      };

      const service = new DocumentsService(mockDb as never, mockAudit);

      const result = await service.listDocuments(
        ORG_ID,
        USER_ID,
        "all",
        { limit: 20, cursor: undefined, userId: undefined, type: undefined, search: undefined, category: undefined },
        ACTIVE_MEMBERSHIP_ID,
      );

      expect(result.data).toHaveLength(0);
    });
  });
});
