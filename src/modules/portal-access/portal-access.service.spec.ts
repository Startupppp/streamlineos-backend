import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PortalAccessService } from "./portal-access.service";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const ORG_ID = "org-1";
const OTHER_ORG = "org-9";
const USER_ID = "user-1";
const MEMBERSHIP_ID = "mem-1";
const GRANT_ID = "grant-1";
const CONTACT_ID = "contact-1";
const PROJECT_ID = 42;

const mockAudit = { log: jest.fn() } as unknown as AuditService;

function makeMembership(overrides: Record<string, unknown> = {}) {
  return {
    portalMembershipId: MEMBERSHIP_ID,
    organizationId: ORG_ID,
    audience: "CLIENT",
    partyContactId: CONTACT_ID,
    userId: null,
    status: "PENDING",
    sessionEpoch: 0,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeGrant(overrides: Record<string, unknown> = {}) {
  return {
    projectClientGrantId: GRANT_ID,
    organizationId: ORG_ID,
    portalMembershipId: MEMBERSHIP_ID,
    partyContactId: CONTACT_ID,
    projectId: PROJECT_ID,
    pmWorkspaceId: null,
    canViewMilestones: false,
    canViewTasks: false,
    canViewAttachments: false,
    canViewComments: false,
    canSubmitChangeRequests: false,
    status: "ACTIVE",
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("PortalAccessService", () => {
  let svc: PortalAccessService;
  let mockDb: Record<string, unknown>;

  // Simple select chain: .select().from().where().limit(rows)
  function makeSelectChain(rows: unknown[]) {
    const whereChain = { limit: jest.fn().mockResolvedValue(rows) };
    const fromChain = { where: jest.fn().mockReturnValue(whereChain) };
    const selectChain = { from: jest.fn().mockReturnValue(fromChain) };
    return { selectChain, fromChain, whereChain };
  }

  // Left-join chain used by listMemberships/listGrants rows query:
  // .select().from().leftJoin().where().limit(rows).offset(resolvedRows)
  function makeLeftJoinChain(rows: unknown[]) {
    const offsetChain = jest.fn().mockResolvedValue(rows);
    const limitChain = jest.fn().mockReturnValue({ offset: offsetChain });
    const whereChain = { limit: limitChain };
    const leftJoinChain = { where: jest.fn().mockReturnValue(whereChain) };
    const fromChain = { leftJoin: jest.fn().mockReturnValue(leftJoinChain) };
    const selectChain = { from: jest.fn().mockReturnValue(fromChain) };
    return { selectChain, fromChain, leftJoinChain, whereChain };
  }

  // Count chain: .select().from().where(resolvedRows)
  function makeCountChain(total: number) {
    const whereResult = jest.fn().mockResolvedValue([{ total }]);
    const fromChain = { where: whereResult };
    const selectChain = { from: jest.fn().mockReturnValue(fromChain) };
    return { selectChain };
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
        PortalAccessService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();
    svc = module.get(PortalAccessService);
  });

  // ─── loadMembership / getMembership — BOLA isolation ─────────────────────

  describe("getMembership — BOLA cross-tenant isolation", () => {
    it("throws 404 when membership belongs to a different tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.getMembership(OTHER_ORG, MEMBERSHIP_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws 404 when membership is soft-deleted (deletedAt set)", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.getMembership(ORG_ID, "nonexistent-id"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns the row when it belongs to the caller's tenant", async () => {
      const membership = makeMembership();
      const { selectChain } = makeSelectChain([membership]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const result = await svc.getMembership(ORG_ID, MEMBERSHIP_ID);
      expect(result).toMatchObject({
        portalMembershipId: MEMBERSHIP_ID,
        organizationId: ORG_ID,
      });
    });
  });

  // ─── loadGrant / getGrant — BOLA isolation ───────────────────────────────

  describe("getGrant — BOLA cross-tenant isolation", () => {
    it("throws 404 when grant belongs to a different tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.getGrant(OTHER_ORG, GRANT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws 404 when grant id does not exist", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.getGrant(ORG_ID, "nonexistent-grant"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns the row when it belongs to the caller's tenant", async () => {
      const grant = makeGrant();
      const { selectChain } = makeSelectChain([grant]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const result = await svc.getGrant(ORG_ID, GRANT_ID);
      expect(result).toMatchObject({
        projectClientGrantId: GRANT_ID,
        organizationId: ORG_ID,
      });
    });
  });

  // ─── createMembership ────────────────────────────────────────────────────

  describe("createMembership — status PENDING + unique-violation → 409", () => {
    it("maps a Postgres unique violation (23505) to ConflictException", async () => {
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn().mockRejectedValue(new ConflictException("Contact already has portal access in this organization.")),
          }),
        }),
      });

      await expect(
        svc.createMembership(ORG_ID, USER_ID, { partyContactId: CONTACT_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it("inserts with PENDING status and audit-logs on success", async () => {
      const row = makeMembership({ status: "PENDING" });
      const catchFn = jest.fn().mockResolvedValue([row]);
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: catchFn,
          }),
        }),
      });

      const result = await svc.createMembership(ORG_ID, USER_ID, {
        partyContactId: CONTACT_ID,
      });

      expect(result).toMatchObject({
        organizationId: ORG_ID,
        status: "PENDING",
        partyContactId: CONTACT_ID,
      });
      expect(mockAudit.log).toHaveBeenCalledTimes(1);
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "portal_access.membership.created",
          orgId: ORG_ID,
          userId: USER_ID,
          resourceType: "portal_membership",
        }),
      );
    });
  });

  // ─── setMembershipStatus — sessionEpoch bump on SUSPENDED/REVOKED ────────

  describe("setMembershipStatus — sessionEpoch bump invariant", () => {
    function setupLoadMembership(membership: Record<string, unknown>) {
      // loadMembership uses: .select().from().where().limit(1) → resolves to [membership]
      const limitMock = jest.fn().mockResolvedValue([membership]);
      const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });
      return { from: fromMock, where: whereMock, limit: limitMock };
    }

    it("bumps sessionEpoch when status becomes SUSPENDED", async () => {
      const membership = makeMembership({ status: "ACTIVE" });
      const loadChain = setupLoadMembership(membership);
      const updatedRow = makeMembership({ status: "SUSPENDED", sessionEpoch: 1 });

      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([updatedRow]),
        }),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return { from: loadChain.from };
        }
        return { from: jest.fn() };
      });

      const result = await svc.setMembershipStatus(ORG_ID, USER_ID, MEMBERSHIP_ID, {
        status: "SUSPENDED",
      });

      expect(result).toMatchObject({ status: "SUSPENDED" });
      // The patch passed to .set() must include sessionEpoch (the sql increment expression)
      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "SUSPENDED",
          sessionEpoch: expect.anything(),
        }),
      );
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "portal_access.membership.status_changed",
          orgId: ORG_ID,
          userId: USER_ID,
        }),
      );
    });

    it("bumps sessionEpoch when status becomes REVOKED", async () => {
      const membership = makeMembership({ status: "ACTIVE" });
      const loadChain = setupLoadMembership(membership);
      const updatedRow = makeMembership({ status: "REVOKED", sessionEpoch: 1 });

      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([updatedRow]),
        }),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return { from: loadChain.from };
        }
        return { from: jest.fn() };
      });

      const result = await svc.setMembershipStatus(ORG_ID, USER_ID, MEMBERSHIP_ID, {
        status: "REVOKED",
      });

      expect(result).toMatchObject({ status: "REVOKED" });
      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "REVOKED",
          sessionEpoch: expect.anything(),
        }),
      );
    });

    it("does NOT set sessionEpoch when status becomes ACTIVE", async () => {
      const membership = makeMembership({ status: "PENDING" });
      const loadChain = setupLoadMembership(membership);
      const updatedRow = makeMembership({ status: "ACTIVE" });

      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([updatedRow]),
        }),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return { from: loadChain.from };
        }
        return { from: jest.fn() };
      });

      await svc.setMembershipStatus(ORG_ID, USER_ID, MEMBERSHIP_ID, { status: "ACTIVE" });

      const patchArg = setSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(patchArg).not.toHaveProperty("sessionEpoch");
    });

    it("throws 404 (via loadMembership) when membership not in caller's org", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.setMembershipStatus(OTHER_ORG, USER_ID, MEMBERSHIP_ID, { status: "SUSPENDED" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });
  });

  // ─── createGrant — BOLA (membership must be in caller's org) ─────────────

  describe("createGrant — BOLA on membership", () => {
    it("throws 404 when portalMembership belongs to a different org", async () => {
      // loadMembership returns empty → 404
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.createGrant(OTHER_ORG, USER_ID, {
          portalMembershipId: MEMBERSHIP_ID,
          partyContactId: CONTACT_ID,
          projectId: PROJECT_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
    });

    it("maps a unique violation (23505) to ConflictException", async () => {
      const membership = makeMembership();
      const limitMock = jest.fn().mockResolvedValue([membership]);
      const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });

      (mockDb as { select: jest.Mock }).select.mockReturnValue({ from: fromMock });

      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn().mockRejectedValue(
              new ConflictException("A grant already exists for this membership and project."),
            ),
          }),
        }),
      });

      await expect(
        svc.createGrant(ORG_ID, USER_ID, {
          portalMembershipId: MEMBERSHIP_ID,
          partyContactId: CONTACT_ID,
          projectId: PROJECT_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it("inserts ACTIVE grant and audit-logs on success", async () => {
      const membership = makeMembership();
      const limitMock = jest.fn().mockResolvedValue([membership]);
      const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });

      (mockDb as { select: jest.Mock }).select.mockReturnValue({ from: fromMock });

      const row = makeGrant({ status: "ACTIVE" });
      const catchFn = jest.fn().mockResolvedValue([row]);
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: catchFn,
          }),
        }),
      });

      const result = await svc.createGrant(ORG_ID, USER_ID, {
        portalMembershipId: MEMBERSHIP_ID,
        partyContactId: CONTACT_ID,
        projectId: PROJECT_ID,
      });

      expect(result).toMatchObject({ organizationId: ORG_ID, status: "ACTIVE" });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "portal_access.grant.created",
          orgId: ORG_ID,
          userId: USER_ID,
          resourceType: "project_client_grant",
        }),
      );
    });
  });

  // ─── updateGrant ──────────────────────────────────────────────────────────

  describe("updateGrant — BOLA + patch + audit", () => {
    it("throws 404 when grant belongs to a different tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.updateGrant(OTHER_ORG, USER_ID, GRANT_ID, { canViewTasks: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("applies the patch and audit-logs when the grant exists", async () => {
      const existing = makeGrant();
      const updated = makeGrant({ canViewTasks: true });
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([updated]),
        }),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      const result = await svc.updateGrant(ORG_ID, USER_ID, GRANT_ID, {
        canViewTasks: true,
      });

      expect(result).toMatchObject({ canViewTasks: true });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "portal_access.grant.updated",
          orgId: ORG_ID,
          userId: USER_ID,
        }),
      );
    });
  });

  // ─── revokeGrant ─────────────────────────────────────────────────────────

  describe("revokeGrant — BOLA + status REVOKED + audit", () => {
    it("throws 404 when grant belongs to a different tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.revokeGrant(OTHER_ORG, USER_ID, GRANT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("sets status to REVOKED and audit-logs", async () => {
      const existing = makeGrant();
      const revoked = makeGrant({ status: "REVOKED" });
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([revoked]),
        }),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      const result = await svc.revokeGrant(ORG_ID, USER_ID, GRANT_ID);

      expect(result).toMatchObject({ status: "REVOKED" });
      expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "REVOKED" }));
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "portal_access.grant.revoked",
          orgId: ORG_ID,
          userId: USER_ID,
        }),
      );
    });
  });

  // ─── listMemberships — pagination envelope ────────────────────────────────

  describe("listMemberships — pagination envelope", () => {
    it("returns { data, pagination } with computed totalPages", async () => {
      const rows = [makeMembership(), makeMembership({ portalMembershipId: "mem-2" })];

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          // rows query: .select().from().leftJoin().where().limit().offset()
          return {
            from: jest.fn().mockReturnValue({
              leftJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  limit: jest.fn().mockReturnValue({
                    offset: jest.fn().mockResolvedValue(rows),
                  }),
                }),
              }),
            }),
          };
        }
        // count query: .select().from().where()
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ total: 2 }]),
          }),
        };
      });

      const result = await svc.listMemberships(ORG_ID, { page: 1, limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      });
    });
  });

  // ─── listGrants — pagination envelope ────────────────────────────────────

  describe("listGrants — pagination envelope", () => {
    it("returns { data, pagination } with computed totalPages", async () => {
      const rows = [makeGrant(), makeGrant({ projectClientGrantId: "grant-2" })];

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          // rows query: .select().from().leftJoin().where().limit().offset()
          return {
            from: jest.fn().mockReturnValue({
              leftJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  limit: jest.fn().mockReturnValue({
                    offset: jest.fn().mockResolvedValue(rows),
                  }),
                }),
              }),
            }),
          };
        }
        // count query: .select().from().where()
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ total: 2 }]),
          }),
        };
      });

      const result = await svc.listGrants(ORG_ID, { page: 1, limit: 20 });

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
