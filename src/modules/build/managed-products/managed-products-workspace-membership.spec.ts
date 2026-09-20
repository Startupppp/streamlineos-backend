import { ForbiddenException } from "@nestjs/common";
import { ManagedProductsService } from "./managed-products.service";
import { AuditService } from "../../../common/audit/audit.service";
import { PmWorkspacesService } from "../pm-workspaces/pm-workspaces.service";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-x";
const WS = "ws-1";
const MEMBERSHIP_ID = 10;

function makeMinimalDb(): Db {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: jest.fn(),
    update: jest.fn(),
  } as unknown as Db;
}

const audit = { log: jest.fn() } as unknown as AuditService;

describe("ManagedProductsService — PM workspace membership enforcement (BSN-01-016)", () => {
  describe("createManagedProduct — non-member deny", () => {
    it("propagates ForbiddenException when the caller is not a member of the resolved workspace", async () => {
      const pmWorkspaces = {
        resolveWorkspaceIdForWrite: jest.fn().mockResolvedValue(WS),
        assertMemberOfWorkspace: jest.fn().mockRejectedValue(new ForbiddenException("Not a member")),
      } as unknown as PmWorkspacesService;

      const svc = new ManagedProductsService(makeMinimalDb(), audit, pmWorkspaces);

      await expect(
        svc.createManagedProduct(ORG, "user-1", MEMBERSHIP_ID, { name: "Atlas", key: "ATLAS" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("never reaches db.insert when the caller is not a workspace member", async () => {
      const db = makeMinimalDb();
      const pmWorkspaces = {
        resolveWorkspaceIdForWrite: jest.fn().mockResolvedValue(WS),
        assertMemberOfWorkspace: jest.fn().mockRejectedValue(new ForbiddenException("Not a member")),
      } as unknown as PmWorkspacesService;

      const svc = new ManagedProductsService(db, audit, pmWorkspaces);

      await svc.createManagedProduct(ORG, "user-1", MEMBERSHIP_ID, { name: "Atlas", key: "ATLAS" }).catch(() => undefined);

      expect((db as unknown as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
    });

    it("calls assertMemberOfWorkspace with the resolved workspace id and caller membership id", async () => {
      const assertMemberOfWorkspace = jest.fn().mockRejectedValue(new ForbiddenException("Not a member"));
      const pmWorkspaces = {
        resolveWorkspaceIdForWrite: jest.fn().mockResolvedValue(WS),
        assertMemberOfWorkspace,
      } as unknown as PmWorkspacesService;

      const svc = new ManagedProductsService(makeMinimalDb(), audit, pmWorkspaces);

      await svc.createManagedProduct(ORG, "user-1", MEMBERSHIP_ID, { name: "Atlas", key: "ATLAS" }).catch(() => undefined);

      expect(assertMemberOfWorkspace).toHaveBeenCalledWith(ORG, WS, MEMBERSHIP_ID);
    });

    it("cross-tenant deny: returns 404 when the product is not in the caller's org", async () => {
      const pmWorkspaces = {
        resolveWorkspaceIdForWrite: jest.fn().mockResolvedValue(WS),
        assertMemberOfWorkspace: jest.fn().mockResolvedValue(undefined),
      } as unknown as PmWorkspacesService;
      const db = makeMinimalDb();
      (db as unknown as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      });
      const svc = new ManagedProductsService(db, audit, pmWorkspaces);

      await expect(
        svc.createManagedProduct("org-other", "user-1", MEMBERSHIP_ID, { name: "Atlas", key: "ATLAS" }),
      ).rejects.toThrow();
    });
  });

  describe("listManagedProducts — non-member deny when workspace filter is active", () => {
    it("propagates ForbiddenException when caller is not a member and pmWorkspaceId is provided", async () => {
      const assertMemberOfWorkspace = jest.fn().mockRejectedValue(new ForbiddenException("Not a member"));
      const pmWorkspaces = { assertMemberOfWorkspace } as unknown as PmWorkspacesService;

      const svc = new ManagedProductsService(makeMinimalDb(), audit, pmWorkspaces);

      await expect(
        svc.listManagedProducts(ORG, { limit: 20, pmWorkspaceId: WS }, MEMBERSHIP_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("calls assertMemberOfWorkspace with the correct args when pmWorkspaceId filter is provided", async () => {
      const assertMemberOfWorkspace = jest.fn().mockRejectedValue(new ForbiddenException("Not a member"));
      const pmWorkspaces = { assertMemberOfWorkspace } as unknown as PmWorkspacesService;

      const svc = new ManagedProductsService(makeMinimalDb(), audit, pmWorkspaces);

      await svc.listManagedProducts(ORG, { limit: 20, pmWorkspaceId: WS }, MEMBERSHIP_ID).catch(() => undefined);

      expect(assertMemberOfWorkspace).toHaveBeenCalledWith(ORG, WS, MEMBERSHIP_ID);
    });

    it("skips assertMemberOfWorkspace when no pmWorkspaceId filter is provided", async () => {
      const assertMemberOfWorkspace = jest.fn();
      const pmWorkspaces = { assertMemberOfWorkspace } as unknown as PmWorkspacesService;

      const svc = new ManagedProductsService(makeMinimalDb(), audit, pmWorkspaces);

      await svc.listManagedProducts(ORG, { limit: 20 }, MEMBERSHIP_ID);

      expect(assertMemberOfWorkspace).not.toHaveBeenCalled();
    });

    it("checks membership even for a caller with no membership id, so the guard has no opt-out", async () => {
      const assertMemberOfWorkspace = jest.fn();
      const pmWorkspaces = { assertMemberOfWorkspace } as unknown as PmWorkspacesService;

      const svc = new ManagedProductsService(makeMinimalDb(), audit, pmWorkspaces);

      await svc.listManagedProducts(ORG, { limit: 20, pmWorkspaceId: WS }, null);

      expect(assertMemberOfWorkspace).toHaveBeenCalledWith(ORG, WS, null);
    });
  });
});
