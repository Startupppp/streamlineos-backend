import { ForbiddenException } from "@nestjs/common";
import { TeamsService } from "./teams.service";
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
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    }),
    insert: jest.fn(),
    update: jest.fn(),
  } as unknown as Db;
}

const audit = { log: jest.fn() } as unknown as AuditService;

describe("TeamsService — PM workspace membership enforcement (BSN-01-016)", () => {
  describe("createTeam — non-member deny", () => {
    it("propagates ForbiddenException when the caller is not a member of the resolved workspace", async () => {
      const pmWorkspaces = {
        resolveWorkspaceIdForWrite: jest.fn().mockResolvedValue(WS),
        assertMemberOfWorkspace: jest.fn().mockRejectedValue(new ForbiddenException("Not a member")),
      } as unknown as PmWorkspacesService;

      const svc = new TeamsService(makeMinimalDb(), audit, pmWorkspaces);

      await expect(
        svc.createTeam(ORG, "user-1", MEMBERSHIP_ID, { name: "Alpha", key: "ALPHA" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("never reaches db.insert when the caller is not a workspace member", async () => {
      const db = makeMinimalDb();
      const pmWorkspaces = {
        resolveWorkspaceIdForWrite: jest.fn().mockResolvedValue(WS),
        assertMemberOfWorkspace: jest.fn().mockRejectedValue(new ForbiddenException("Not a member")),
      } as unknown as PmWorkspacesService;

      const svc = new TeamsService(db, audit, pmWorkspaces);

      await svc.createTeam(ORG, "user-1", MEMBERSHIP_ID, { name: "Alpha", key: "ALPHA" }).catch(() => undefined);

      expect((db as unknown as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
    });

    it("calls assertMemberOfWorkspace with the resolved workspace id and caller membership id", async () => {
      const assertMemberOfWorkspace = jest.fn().mockRejectedValue(new ForbiddenException("Not a member"));
      const pmWorkspaces = {
        resolveWorkspaceIdForWrite: jest.fn().mockResolvedValue(WS),
        assertMemberOfWorkspace,
      } as unknown as PmWorkspacesService;

      const svc = new TeamsService(makeMinimalDb(), audit, pmWorkspaces);

      await svc.createTeam(ORG, "user-1", MEMBERSHIP_ID, { name: "Alpha", key: "ALPHA" }).catch(() => undefined);

      expect(assertMemberOfWorkspace).toHaveBeenCalledWith(ORG, WS, MEMBERSHIP_ID);
    });

    it("cross-tenant deny: loadTeam returns NotFoundException when team belongs to a different org", async () => {
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

      const svc = new TeamsService(db, audit, pmWorkspaces);

      await expect(
        svc.createTeam("org-other", "user-1", MEMBERSHIP_ID, { name: "Alpha", key: "ALPHA" }),
      ).rejects.toThrow();
    });
  });

  describe("listTeams — non-member deny when workspace filter is active", () => {
    it("propagates ForbiddenException when caller is not a member and pmWorkspaceId is provided", async () => {
      const assertMemberOfWorkspace = jest.fn().mockRejectedValue(new ForbiddenException("Not a member"));
      const pmWorkspaces = { assertMemberOfWorkspace } as unknown as PmWorkspacesService;

      const svc = new TeamsService(makeMinimalDb(), audit, pmWorkspaces);

      await expect(
        svc.listTeams(ORG, { pageSize: 50, pmWorkspaceId: WS }, MEMBERSHIP_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("calls assertMemberOfWorkspace with the correct args when pmWorkspaceId filter is provided", async () => {
      const assertMemberOfWorkspace = jest.fn().mockRejectedValue(new ForbiddenException("Not a member"));
      const pmWorkspaces = { assertMemberOfWorkspace } as unknown as PmWorkspacesService;

      const svc = new TeamsService(makeMinimalDb(), audit, pmWorkspaces);

      await svc.listTeams(ORG, { pageSize: 50, pmWorkspaceId: WS }, MEMBERSHIP_ID).catch(() => undefined);

      expect(assertMemberOfWorkspace).toHaveBeenCalledWith(ORG, WS, MEMBERSHIP_ID);
    });

    it("skips assertMemberOfWorkspace when no pmWorkspaceId filter is provided", async () => {
      const assertMemberOfWorkspace = jest.fn();
      const pmWorkspaces = { assertMemberOfWorkspace } as unknown as PmWorkspacesService;

      const svc = new TeamsService(makeMinimalDb(), audit, pmWorkspaces);

      await svc.listTeams(ORG, { pageSize: 50 }, MEMBERSHIP_ID);

      expect(assertMemberOfWorkspace).not.toHaveBeenCalled();
    });

    it("checks membership even for a caller with no membership id, so the guard has no opt-out", async () => {
      const assertMemberOfWorkspace = jest.fn();
      const pmWorkspaces = { assertMemberOfWorkspace } as unknown as PmWorkspacesService;

      const svc = new TeamsService(makeMinimalDb(), audit, pmWorkspaces);

      await svc.listTeams(ORG, { pageSize: 50, pmWorkspaceId: WS }, null);

      expect(assertMemberOfWorkspace).toHaveBeenCalledWith(ORG, WS, null);
    });
  });
});
