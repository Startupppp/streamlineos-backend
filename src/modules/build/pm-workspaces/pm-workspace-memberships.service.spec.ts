import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PmWorkspaceMembershipsService } from "./pm-workspace-memberships.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

jest.mock("../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

const ORG_ID = "org-1";
const OTHER_ORG = "org-9";
const USER_ID = "user-1";
const WORKSPACE_ID = "pmw-1";
const MEMBER_USER_ID = "11111111-1111-1111-1111-111111111111";
const MEMBERSHIP_ROW_ID = "pmwm-1";
const ACTOR_MEMBERSHIP_ID = 10;
const TARGET_MEMBERSHIP_ID = 42;

const mockAudit = { log: jest.fn() } as unknown as AuditService;

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    pmWorkspaceId: WORKSPACE_ID,
    orgId: ORG_ID,
    name: "Default Workspace",
    slug: "default",
    isDefault: false,
    status: "active",
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMemberRow(overrides: Record<string, unknown> = {}) {
  return {
    pmWorkspaceMembershipId: MEMBERSHIP_ROW_ID,
    orgId: ORG_ID,
    pmWorkspaceId: WORKSPACE_ID,
    organizationMembershipId: TARGET_MEMBERSHIP_ID,
    role: "member",
    addedAt: new Date(),
    ...overrides,
  };
}

describe("PmWorkspaceMembershipsService", () => {
  let svc: PmWorkspaceMembershipsService;
  let mockDb: Record<string, unknown>;

  function mockSelectOnce(rows: unknown[]) {
    (mockDb as { select: jest.Mock }).select.mockReturnValueOnce({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(rows),
        }),
      }),
    });
  }

  function mockSelectWithJoinOnce(rows: unknown[]) {
    (mockDb as { select: jest.Mock }).select.mockReturnValueOnce({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    });
  }

  beforeEach(async () => {
    jest.resetAllMocks();

    mockDb = {
      select: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      query: {},
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
    };

    const module = await Test.createTestingModule({
      providers: [
        PmWorkspaceMembershipsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();
    svc = module.get(PmWorkspaceMembershipsService);
  });

  describe("assertWorkspaceExists â tenant isolation", () => {
    it("throws 404 when the workspace belongs to a different tenant", async () => {
      mockSelectOnce([]);
      await expect(
        svc.addMember(OTHER_ORG, USER_ID, WORKSPACE_ID, {
          userId: MEMBER_USER_ID,
          role: "member",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("addMember â validates org membership + tenant isolation", () => {
    it("throws 404 when the user is not an active member of the org", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectOnce([]);
      await expect(
        svc.addMember(ORG_ID, USER_ID, WORKSPACE_ID, {
          userId: MEMBER_USER_ID,
          role: "member",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
    });

    it("maps a duplicate-member unique violation to ConflictException", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectOnce([{ id: 42 }]);
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue({ code: "23505" }),
        }),
      });

      await expect(
        svc.addMember(ORG_ID, USER_ID, WORKSPACE_ID, {
          userId: MEMBER_USER_ID,
          role: "member",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("inserts and audit-logs when the member and workspace exist", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectOnce([{ id: 42 }]);
      const memberRow = {
        pmWorkspaceMembershipId: "pmwm-1",
        orgId: ORG_ID,
        pmWorkspaceId: WORKSPACE_ID,
        organizationMembershipId: 42,
        role: "member",
        addedAt: new Date(),
      };
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([memberRow]),
        }),
      });

      const result = await svc.addMember(ORG_ID, USER_ID, WORKSPACE_ID, {
        userId: MEMBER_USER_ID,
        role: "member",
      });

      expect(result).toMatchObject({
        pmWorkspaceMembershipId: "pmwm-1",
        userId: MEMBER_USER_ID,
      });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "pm_workspace.member.added",
          orgId: ORG_ID,
        }),
      );
    });
  });

  describe("removeMember â last-admin protection", () => {
    it("throws ForbiddenException when removing the last admin", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectOnce([makeMemberRow({ role: "admin" })]);
      mockSelectOnce([{ id: MEMBERSHIP_ROW_ID }]);

      (mockDb as { delete: jest.Mock }).delete.mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      });

      await expect(
        svc.removeMember(ORG_ID, USER_ID, WORKSPACE_ID, MEMBERSHIP_ROW_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((mockDb as { delete: jest.Mock }).delete).not.toHaveBeenCalled();
    });

    it("removes an admin when another admin remains", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectOnce([makeMemberRow({ role: "admin" })]);
      mockSelectOnce([
        { id: MEMBERSHIP_ROW_ID },
        { id: "pmwm-other-admin" },
      ]);

      (mockDb as { delete: jest.Mock }).delete.mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      });

      await expect(
        svc.removeMember(ORG_ID, USER_ID, WORKSPACE_ID, MEMBERSHIP_ROW_ID),
      ).resolves.toEqual({ success: true });
    });

    it("removes a non-admin member regardless of admin count", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectOnce([makeMemberRow({ role: "member" })]);

      (mockDb as { delete: jest.Mock }).delete.mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      });

      await expect(
        svc.removeMember(ORG_ID, USER_ID, WORKSPACE_ID, MEMBERSHIP_ROW_ID),
      ).resolves.toEqual({ success: true });
    });

    it("throws 404 when the workspace is missing", async () => {
      mockSelectOnce([]);

      await expect(
        svc.removeMember(ORG_ID, USER_ID, WORKSPACE_ID, MEMBERSHIP_ROW_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws 404 when the membership is missing", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectOnce([]);

      await expect(
        svc.removeMember(ORG_ID, USER_ID, WORKSPACE_ID, MEMBERSHIP_ROW_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("audit-logs on successful removal", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectOnce([makeMemberRow({ role: "member" })]);

      (mockDb as { delete: jest.Mock }).delete.mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      });

      await svc.removeMember(ORG_ID, USER_ID, WORKSPACE_ID, MEMBERSHIP_ROW_ID);

      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "pm_workspace.member.removed",
          orgId: ORG_ID,
        }),
      );
    });
  });

  describe("updateMemberRole â self-escalation and last-admin demotion protection", () => {
    it("throws ForbiddenException when the actor tries to promote their own role", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectWithJoinOnce([{
        organizationMembershipId: ACTOR_MEMBERSHIP_ID,
        role: "member",
        userId: MEMBER_USER_ID,
      }]);

      await expect(
        svc.updateMemberRole(
          ORG_ID,
          USER_ID,
          WORKSPACE_ID,
          MEMBERSHIP_ROW_ID,
          { role: "admin" },
          ACTOR_MEMBERSHIP_ID,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("allows a different actor to promote a member to admin", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectWithJoinOnce([{
        organizationMembershipId: TARGET_MEMBERSHIP_ID,
        role: "member",
        userId: MEMBER_USER_ID,
      }]);
      const updatedRow = makeMemberRow({ role: "admin" });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updatedRow]),
          }),
        }),
      });

      const result = await svc.updateMemberRole(
        ORG_ID,
        USER_ID,
        WORKSPACE_ID,
        MEMBERSHIP_ROW_ID,
        { role: "admin" },
        ACTOR_MEMBERSHIP_ID,
      );

      expect(result).toMatchObject({ role: "admin", userId: MEMBER_USER_ID });
    });

    it("throws ForbiddenException when demoting the last admin", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectWithJoinOnce([{
        organizationMembershipId: TARGET_MEMBERSHIP_ID,
        role: "admin",
        userId: MEMBER_USER_ID,
      }]);
      mockSelectOnce([{ id: MEMBERSHIP_ROW_ID }]);

      await expect(
        svc.updateMemberRole(
          ORG_ID,
          USER_ID,
          WORKSPACE_ID,
          MEMBERSHIP_ROW_ID,
          { role: "member" },
          ACTOR_MEMBERSHIP_ID,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("allows demoting an admin when another admin remains", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectWithJoinOnce([{
        organizationMembershipId: TARGET_MEMBERSHIP_ID,
        role: "admin",
        userId: MEMBER_USER_ID,
      }]);
      mockSelectOnce([{ id: MEMBERSHIP_ROW_ID }, { id: "pmwm-other-admin" }]);
      const updatedRow = makeMemberRow({ role: "member" });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updatedRow]),
          }),
        }),
      });

      const result = await svc.updateMemberRole(
        ORG_ID,
        USER_ID,
        WORKSPACE_ID,
        MEMBERSHIP_ROW_ID,
        { role: "member" },
        ACTOR_MEMBERSHIP_ID,
      );

      expect(result).toMatchObject({ role: "member", userId: MEMBER_USER_ID });
    });

    it("throws 404 when the membership does not exist in this workspace", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectWithJoinOnce([]);

      await expect(
        svc.updateMemberRole(
          ORG_ID,
          USER_ID,
          WORKSPACE_ID,
          MEMBERSHIP_ROW_ID,
          { role: "admin" },
          ACTOR_MEMBERSHIP_ID,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("audit-logs on successful role change", async () => {
      mockSelectOnce([makeWorkspace()]);
      mockSelectWithJoinOnce([{
        organizationMembershipId: TARGET_MEMBERSHIP_ID,
        role: "member",
        userId: MEMBER_USER_ID,
      }]);
      const updatedRow = makeMemberRow({ role: "admin" });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updatedRow]),
          }),
        }),
      });

      await svc.updateMemberRole(
        ORG_ID,
        USER_ID,
        WORKSPACE_ID,
        MEMBERSHIP_ROW_ID,
        { role: "admin" },
        ACTOR_MEMBERSHIP_ID,
      );

      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "pm_workspace.member.role_updated",
          orgId: ORG_ID,
        }),
      );
    });
  });
});
