import {
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PmWorkspaceMembershipsService } from "./pm-workspace-memberships.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

const ORG_ID = "org-1";
const OTHER_ORG = "org-9";
const USER_ID = "user-1";
const WORKSPACE_ID = "pmw-1";
const MEMBER_USER_ID = "11111111-1111-1111-1111-111111111111";

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

  beforeEach(async () => {
    jest.resetAllMocks();

    mockDb = {
      select: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      query: {},
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

  describe("assertWorkspaceExists — tenant isolation", () => {
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

  describe("addMember — validates org membership + tenant isolation", () => {
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
});
