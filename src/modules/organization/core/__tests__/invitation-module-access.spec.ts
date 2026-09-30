import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { AccessService } from "../../../access/access.service";
import { EmailService } from "../../../email/email.service";
import { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../../billing/core/seat-ledger.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { MembershipAdmissionService } from "../membership-admission.service";
import { InvitationLifecycleService } from "../invitation-lifecycle.service";
import { InvitationAcceptanceService } from "../invitation-acceptance.service";
import { InvitationCreateService } from "../invitation-create.service";
import { inviteUserSchema } from "../../../users/dto/users.schemas";
import { assertMayAssignRole } from "../../../rbac/assert-role-assignment";
import { resolveModuleStandingRole } from "../../../rbac/resolve-module-standing-role";
import { bumpPermissionsVersion } from "../../../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { roleAssignments } from "../../../../db/schema";
import type { InviteActor } from "../invitations.helpers";

jest.mock("../../../rbac/resolve-module-standing-role", () => ({
  resolveModuleStandingRole: jest.fn(),
  validateModuleKeyAndStanding: jest.fn(),
}));

jest.mock("../../../rbac/assert-role-assignment", () => ({
  assertMayAssignRole: jest.fn(),
}));

jest.mock("../../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../../../common/rbac/assert-may-grant-role", () => ({
  assertMayGrantRole: jest.fn().mockResolvedValue(undefined),
  assertMayManageOrganizationMembership: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
  runInNewTenantTransaction: jest.fn().mockResolvedValue(undefined),
}));

const FUTURE = new Date(Date.now() + 86_400_000);
const ORG_ID = "org-abc";
const INVITE_ID = "inv-xyz";
const USER_ID = "user-1";
const INVITER_MEMBERSHIP_ID = 5;

const actor: InviteActor = { userId: USER_ID, isOrgOwner: false };
const resolvedRole = { id: 10, rank: 3, moduleKey: "hr", slug: "HR_MODULE_MEMBER" };

beforeEach(() => {
  jest.clearAllMocks();
});

type ServiceWithPrivateMethods = {
  applyPendingRoleGrants: (
    tx: unknown,
    orgId: string,
    invitationId: string,
    membershipId: number,
    inviterMembershipId: number | null,
  ) => Promise<void>;
  validateModuleAccess: (
    orgId: string,
    actor: InviteActor,
    moduleAccess: Array<{ moduleKey: string; standing: string }> | undefined,
  ) => Promise<Array<{ moduleKey: string; standing: string }>>;
};

describe("validateModuleKeyAndStanding — input contract", () => {
  const { validateModuleKeyAndStanding } = jest.requireActual<{
    validateModuleKeyAndStanding: (key: string, standing: string) => void;
  }>("../../../rbac/resolve-module-standing-role");

  it("rejects MEMBER standing for a module not in ACCESS_MANAGED_MODULES", () => {
    expect(() => validateModuleKeyAndStanding("kb", "MEMBER")).toThrow(BadRequestException);
  });

  it("rejects ADMIN standing for a completely unknown module key", () => {
    expect(() => validateModuleKeyAndStanding("not-a-module", "ADMIN")).toThrow(BadRequestException);
  });

  it("accepts ADMIN standing for a known module (positive pair)", () => {
    expect(() => validateModuleKeyAndStanding("hr", "ADMIN")).not.toThrow();
  });

  it("accepts MEMBER standing for a delegable module (positive pair)", () => {
    expect(() => validateModuleKeyAndStanding("hr", "MEMBER")).not.toThrow();
  });
});

describe("resolveModuleStandingRole — slug construction and DB lookup", () => {
  const { resolveModuleStandingRole: realResolve } = jest.requireActual<{
    resolveModuleStandingRole: (
      db: unknown,
      orgId: string,
      moduleKey: string,
      standing: string,
    ) => Promise<{ id: number; rank: number; moduleKey: string; slug: string } | null>;
  }>("../../../rbac/resolve-module-standing-role");

  function buildDb(rows: unknown[]) {
    return {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    };
  }

  it("MEMBER standing queries using the MODULE_MEMBER slug", async () => {
    const row = { id: 1, rank: 3, moduleKey: "hr", slug: "HR_MODULE_MEMBER" };
    const result = await realResolve(buildDb([row]), ORG_ID, "hr", "MEMBER");
    expect(result?.slug).toBe("HR_MODULE_MEMBER");
  });

  it("ADMIN standing queries using the MODULE_ADMIN slug", async () => {
    const row = { id: 2, rank: 4, moduleKey: "hr", slug: "HR_MODULE_ADMIN" };
    const result = await realResolve(buildDb([row]), ORG_ID, "hr", "ADMIN");
    expect(result?.slug).toBe("HR_MODULE_ADMIN");
  });

  it("returns null when the role is not seeded in the DB", async () => {
    const result = await realResolve(buildDb([]), ORG_ID, "hr", "MEMBER");
    expect(result).toBeNull();
  });

  it("returns the full role object when the role is found (positive pair)", async () => {
    const row = { id: 3, rank: 3, moduleKey: "crm", slug: "CRM_MODULE_MEMBER" };
    const result = await realResolve(buildDb([row]), ORG_ID, "crm", "MEMBER");
    expect(result).toEqual(row);
  });
});

describe("inviteUserSchema — DTO contract", () => {
  it("rejects duplicate moduleKey entries", () => {
    const result = inviteUserSchema.safeParse({
      email: "a@b.com",
      moduleAccess: [
        { moduleKey: "hr", standing: "MEMBER" },
        { moduleKey: "hr", standing: "ADMIN" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 10 moduleAccess items", () => {
    const items = Array.from({ length: 11 }, (_, i) => ({
      moduleKey: `mod-${i}`,
      standing: "ADMIN",
    }));
    const result = inviteUserSchema.safeParse({ email: "a@b.com", moduleAccess: items });
    expect(result.success).toBe(false);
  });

  it("rejects OWNER as a standing value since the enum is MEMBER | ADMIN only", () => {
    const result = inviteUserSchema.safeParse({
      email: "a@b.com",
      moduleAccess: [{ moduleKey: "hr", standing: "OWNER" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level keys via .strict()", () => {
    const result = inviteUserSchema.safeParse({
      email: "a@b.com",
      unexpectedField: true,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid invite with one moduleAccess item (positive pair)", () => {
    const result = inviteUserSchema.safeParse({
      email: "a@b.com",
      moduleAccess: [{ moduleKey: "hr", standing: "MEMBER" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid invite with exactly 10 moduleAccess items (positive pair for max-10 boundary)", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      moduleKey: `mod-${i}`,
      standing: "ADMIN",
    }));
    const result = inviteUserSchema.safeParse({ email: "a@b.com", moduleAccess: items });
    expect(result.success).toBe(true);
  });
});

describe("InvitationLifecycleService resend() — Finding 1: resend re-validates authority before token is issued", () => {
  const invitation = {
    id: INVITE_ID,
    orgId: ORG_ID,
    email: "invitee@example.com",
    status: "PENDING",
    acceptedAt: null,
    expiresAt: FUTURE,
    inviterMembershipId: null,
  };

  function buildDb(attachedAccess: unknown[]) {
    return {
      query: {
        organizations: {
          findFirst: jest.fn().mockResolvedValue({ name: "Org", status: "ACTIVE", deletedAt: null }),
        },
        invitations: {
          findFirst: jest.fn().mockResolvedValue(invitation),
        },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 1 }),
        },
        users: {
          findFirst: jest.fn().mockResolvedValue({ name: "Sender", firstName: null, lastName: null }),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(attachedAccess),
          }),
        }),
      }),
    };
  }

  async function buildService(db: unknown): Promise<InvitationLifecycleService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationLifecycleService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: { invalidateForOrg: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: EmailService, useValue: { sendInvitationEmail: jest.fn() } },
        {
          provide: PlanLimitsService,
          useValue: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SeatLedgerService,
          useValue: { recordSeatEvent: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: AccessService,
          useValue: { resolveUserPermissions: jest.fn(), getPermissionsVersion: jest.fn() },
        },
      ],
    }).compile();
    return moduleRef.get(InvitationLifecycleService);
  }

  it("throws ForbiddenException before issuing the token when the resender lacks authority to assign the attached standing", async () => {
    const service = await buildService(buildDb([{ moduleKey: "hr", standing: "MEMBER" }]));

    (resolveModuleStandingRole as jest.Mock).mockResolvedValue(resolvedRole);
    (assertMayAssignRole as jest.Mock).mockRejectedValue(new ForbiddenException("not authorised"));

    await expect(
      service.resend(ORG_ID, INVITE_ID, actor, { deliverEmail: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(runInTenantTransaction as jest.Mock).not.toHaveBeenCalled();
  });

  it("proceeds to update the invitation token when the resender is authorised (positive pair)", async () => {
    const txUpdate = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: INVITE_ID }]),
        }),
      }),
    });
    const txInsert = jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    });
    const txMock = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            for: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([
                { id: INVITE_ID, status: "PENDING", expiresAt: FUTURE },
              ]),
            }),
          }),
        }),
      }),
      update: txUpdate,
      insert: txInsert,
    };

    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
    );

    const service = await buildService(buildDb([{ moduleKey: "hr", standing: "MEMBER" }]));

    (resolveModuleStandingRole as jest.Mock).mockResolvedValue(resolvedRole);
    (assertMayAssignRole as jest.Mock).mockResolvedValue(undefined);

    const result = await service.resend(ORG_ID, INVITE_ID, actor, { deliverEmail: false });

    expect(assertMayAssignRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userId: USER_ID }),
      resolvedRole,
    );
    expect(txUpdate).toHaveBeenCalled();
    expect(result).toMatchObject({ success: true });
  });
});

describe("applyPendingRoleGrants — Finding 2: acceptance does not replay stale authority", () => {
  let txInsert: jest.Mock;
  let txFindMembership: jest.Mock;
  let tx: unknown;
  let service: InvitationAcceptanceService;
  let auditLog: jest.Mock;

  beforeEach(async () => {
    txInsert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
      }),
    });
    txFindMembership = jest.fn();

    tx = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ moduleKey: "hr", standing: "MEMBER" }]),
          }),
        }),
      }),
      insert: txInsert,
      query: { organizationMembers: { findFirst: txFindMembership } },
    };

    auditLog = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationAcceptanceService,
        { provide: DRIZZLE, useValue: {} },
        { provide: CacheService, useValue: {} },
        { provide: PlanLimitsService, useValue: {} },
        { provide: SeatLedgerService, useValue: {} },
        { provide: NotificationDispatchService, useValue: {} },
        { provide: EmailService, useValue: {} },
        { provide: AuditService, useValue: { log: auditLog } },
        { provide: AccessService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(InvitationAcceptanceService);
  });

  it("skips the roleAssignments insert and resolves (acceptance survives) when the inviter's membership is no longer active", async () => {
    txFindMembership.mockResolvedValue({
      id: INVITER_MEMBERSHIP_ID,
      userId: "inviter-user",
      status: "INACTIVE",
      isOwner: false,
    });
    (resolveModuleStandingRole as jest.Mock).mockResolvedValue(resolvedRole);
    (assertMayAssignRole as jest.Mock).mockResolvedValue(undefined);

    await expect(
      (service as unknown as ServiceWithPrivateMethods).applyPendingRoleGrants(
        tx,
        ORG_ID,
        INVITE_ID,
        42,
        INVITER_MEMBERSHIP_ID,
      ),
    ).resolves.toBeUndefined();

    expect(txInsert).not.toHaveBeenCalled();
    expect(bumpPermissionsVersion).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: "inviter_not_active" }),
      }),
    );
  });

  it("skips the roleAssignments insert and resolves (acceptance survives) when assertMayAssignRole rejects for the inviter's current context", async () => {
    txFindMembership.mockResolvedValue({
      id: INVITER_MEMBERSHIP_ID,
      userId: "inviter-user",
      status: "ACTIVE",
      isOwner: false,
    });
    (resolveModuleStandingRole as jest.Mock).mockResolvedValue(resolvedRole);
    (assertMayAssignRole as jest.Mock).mockRejectedValue(new ForbiddenException("authority lapsed"));

    await expect(
      (service as unknown as ServiceWithPrivateMethods).applyPendingRoleGrants(
        tx,
        ORG_ID,
        INVITE_ID,
        42,
        INVITER_MEMBERSHIP_ID,
      ),
    ).resolves.toBeUndefined();

    expect(txInsert).not.toHaveBeenCalled();
    expect(bumpPermissionsVersion).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: "inviter_lost_authority" }),
      }),
    );
  });

  it("skips the roleAssignments insert when the role is no longer seeded in the org", async () => {
    txFindMembership.mockResolvedValue({
      id: INVITER_MEMBERSHIP_ID,
      userId: "inviter-user",
      status: "ACTIVE",
      isOwner: false,
    });
    (resolveModuleStandingRole as jest.Mock).mockResolvedValue(null);

    await expect(
      (service as unknown as ServiceWithPrivateMethods).applyPendingRoleGrants(
        tx,
        ORG_ID,
        INVITE_ID,
        42,
        INVITER_MEMBERSHIP_ID,
      ),
    ).resolves.toBeUndefined();

    expect(txInsert).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: "role_no_longer_seeded" }),
      }),
    );
  });

  it("inserts into roleAssignments with the resolved roleId and calls bumpPermissionsVersion on the same tx when authority is valid (positive pair)", async () => {
    txFindMembership.mockResolvedValue({
      id: INVITER_MEMBERSHIP_ID,
      userId: "inviter-user",
      status: "ACTIVE",
      isOwner: false,
    });
    (resolveModuleStandingRole as jest.Mock).mockResolvedValue(resolvedRole);
    (assertMayAssignRole as jest.Mock).mockResolvedValue(undefined);

    await (service as unknown as ServiceWithPrivateMethods).applyPendingRoleGrants(
      tx,
      ORG_ID,
      INVITE_ID,
      42,
      INVITER_MEMBERSHIP_ID,
    );

    expect(txInsert).toHaveBeenCalledWith(roleAssignments);
    expect(bumpPermissionsVersion).toHaveBeenCalledWith(tx, ORG_ID);
  });
});

describe("InvitationCreateService.invite() — invite-time authority check", () => {
  async function buildService(): Promise<InvitationCreateService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationCreateService,
        { provide: DRIZZLE, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: {} },
        { provide: EmailService, useValue: {} },
        { provide: PlanLimitsService, useValue: {} },
        { provide: SeatLedgerService, useValue: {} },
        { provide: AccessService, useValue: {} },
        { provide: MembershipAdmissionService, useValue: {} },
      ],
    }).compile();
    return moduleRef.get(InvitationCreateService);
  }

  it("throws ForbiddenException when the actor cannot assign the attached standing at invite time", async () => {
    const service = await buildService();
    (resolveModuleStandingRole as jest.Mock).mockResolvedValue(resolvedRole);
    (assertMayAssignRole as jest.Mock).mockRejectedValue(new ForbiddenException("not allowed"));

    await expect(
      service.invite(ORG_ID, actor, "a@b.com", "MEMBER", [{ moduleKey: "hr", standing: "MEMBER" }]),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("throws BadRequestException when the role for the given standing is not seeded in the org", async () => {
    const service = await buildService();
    (resolveModuleStandingRole as jest.Mock).mockResolvedValue(null);

    await expect(
      service.invite(ORG_ID, actor, "a@b.com", "MEMBER", [{ moduleKey: "hr", standing: "MEMBER" }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("does not call assertMayAssignRole when the role is not seeded (rejection order is correct)", async () => {
    const service = await buildService();
    (resolveModuleStandingRole as jest.Mock).mockResolvedValue(null);

    await expect(
      service.invite(ORG_ID, actor, "a@b.com", "MEMBER", [{ moduleKey: "hr", standing: "MEMBER" }]),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(assertMayAssignRole).not.toHaveBeenCalled();
  });

  it("calls assertMayAssignRole and does not throw at the validation step when the actor is authorised (positive pair)", async () => {
    const service = await buildService();
    (resolveModuleStandingRole as jest.Mock).mockResolvedValue(resolvedRole);
    (assertMayAssignRole as jest.Mock).mockResolvedValue(undefined);

    const validated = await (service as unknown as ServiceWithPrivateMethods).validateModuleAccess(
      ORG_ID,
      actor,
      [{ moduleKey: "hr", standing: "MEMBER" }],
    );

    expect(assertMayAssignRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userId: USER_ID }),
      resolvedRole,
    );
    expect(validated).toEqual([{ moduleKey: "hr", standing: "MEMBER" }]);
  });
});
