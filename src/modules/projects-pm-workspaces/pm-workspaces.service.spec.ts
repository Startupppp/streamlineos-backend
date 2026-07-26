import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PmWorkspacesService } from "./pm-workspaces.service";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const ORG_ID = "org-1";
const OTHER_ORG = "org-9";
const USER_ID = "user-1";
const WORKSPACE_ID = "pmw-1";

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

describe("PmWorkspacesService", () => {
  let svc: PmWorkspacesService;
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
        PmWorkspacesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();
    svc = module.get(PmWorkspacesService);
  });

  describe("loadWorkspace — BOLA cross-tenant isolation", () => {
    it("throws 404 when the id belongs to a different tenant", async () => {
      mockSelectOnce([]);
      await expect(svc.getWorkspace(OTHER_ORG, WORKSPACE_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("throws 404 when the workspace is soft-deleted", async () => {
      mockSelectOnce([]);
      await expect(svc.getWorkspace(ORG_ID, "missing")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("returns the row when it belongs to the caller's tenant", async () => {
      mockSelectOnce([makeWorkspace()]);
      await expect(svc.getWorkspace(ORG_ID, WORKSPACE_ID)).resolves.toMatchObject({
        pmWorkspaceId: WORKSPACE_ID,
        orgId: ORG_ID,
      });
    });
  });

  describe("createWorkspace — tenant-scoped slug uniqueness (23505 → 409)", () => {
    it("maps a Postgres unique violation to ConflictException", async () => {
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue({ code: "23505" }),
        }),
      });

      await expect(
        svc.createWorkspace(ORG_ID, USER_ID, { name: "Beta", slug: "beta" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it("inserts and audit-logs on success", async () => {
      const row = makeWorkspace({ pmWorkspaceId: "pmw-7", slug: "beta", name: "Beta" });
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([row]),
        }),
      });

      const result = await svc.createWorkspace(ORG_ID, USER_ID, {
        name: "Beta",
        slug: "beta",
      });

      expect(result).toMatchObject({ pmWorkspaceId: "pmw-7", orgId: ORG_ID });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "pm_workspace.created",
          orgId: ORG_ID,
          userId: USER_ID,
          resourceType: "pm_workspace",
        }),
      );
    });
  });

  describe("deleteWorkspace — protects the default workspace", () => {
    it("throws Forbidden when deleting the default workspace (no write)", async () => {
      mockSelectOnce([makeWorkspace({ isDefault: true })]);
      await expect(
        svc.deleteWorkspace(ORG_ID, USER_ID, WORKSPACE_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("throws 404 when the id is not in the caller's tenant (no write)", async () => {
      mockSelectOnce([]);
      await expect(
        svc.deleteWorkspace(OTHER_ORG, USER_ID, WORKSPACE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("soft-deletes a non-default workspace and audit-logs", async () => {
      mockSelectOnce([makeWorkspace({ isDefault: false })]);
      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      await svc.deleteWorkspace(ORG_ID, USER_ID, WORKSPACE_ID);

      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: expect.any(Date) }),
      );
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "pm_workspace.deleted", orgId: ORG_ID }),
      );
    });
  });

  describe("addMember — validates org membership + tenant isolation", () => {
    it("throws 404 when the organization membership is not in the org", async () => {
      mockSelectOnce([makeWorkspace()]); // loadWorkspace
      mockSelectOnce([]); // organizationMembers lookup → none
      await expect(
        svc.addMember(ORG_ID, USER_ID, WORKSPACE_ID, {
          organizationMembershipId: 42,
          role: "member",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
    });

    it("maps a duplicate-member unique violation to ConflictException", async () => {
      mockSelectOnce([makeWorkspace()]); // loadWorkspace
      mockSelectOnce([{ id: 42 }]); // organizationMembers found
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue({ code: "23505" }),
        }),
      });

      await expect(
        svc.addMember(ORG_ID, USER_ID, WORKSPACE_ID, {
          organizationMembershipId: 42,
          role: "member",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("inserts and audit-logs when the member and workspace exist", async () => {
      mockSelectOnce([makeWorkspace()]); // loadWorkspace
      mockSelectOnce([{ id: 42 }]); // organizationMembers found
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
        organizationMembershipId: 42,
        role: "member",
      });

      expect(result).toMatchObject({ pmWorkspaceMembershipId: "pmwm-1" });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "pm_workspace.member.added",
          orgId: ORG_ID,
        }),
      );
    });
  });

  describe("listWorkspaces — pagination envelope", () => {
    it("returns { data, pagination } with computed totalPages", async () => {
      const rows = [makeWorkspace(), makeWorkspace({ pmWorkspaceId: "pmw-2", slug: "b" })];
      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue({
                  offset: jest.fn().mockResolvedValue(rows),
                }),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ total: 2 }]),
          }),
        };
      });

      const result = await svc.listWorkspaces(ORG_ID, { page: 1, limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      });
    });
  });
});
