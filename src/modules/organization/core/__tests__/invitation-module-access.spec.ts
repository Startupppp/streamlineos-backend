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
import { bulkInviteSchema, inviteUserSchema } from "../../../users/dto/users.schemas";
import { assertMayAssignRole } from "../../../rbac/assert-role-assignment";
import { resolveModuleStandingRole } from "../../../rbac/resolve-module-standing-role";
import { commitAccessChange } from "../../../../common/rbac/access-mutation-commit";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import {
  invitationModuleAccess,
  invitations,
  roleAssignments,
} from "../../../../db/schema";
import type { InviteActor } from "../invitations.helpers";

jest.mock("../../../rbac/resolve-module-standing-role", () => ({
  resolveModuleStandingRole: jest.fn(),
  validateModuleKeyAndStanding: jest.fn(),
}));

jest.mock("../../../rbac/assert-role-assignment", () => ({
  assertMayAssignRole: jest.fn(),
}));

jest.mock("../../../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
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
    expect(commitAccessChange).not.toHaveBeenCalled();
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
    expect(commitAccessChange).not.toHaveBeenCalled();
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

  it("inserts into roleAssignments with the resolved roleId and calls commitAccessChange on the same tx when authority is valid (positive pair)", async () => {
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
    expect(commitAccessChange).toHaveBeenCalledWith(tx, ORG_ID, {
      audit: expect.objectContaining({
        action: "user.invitation.module_access_granted",
        systemActor: "invitation-acceptance",
        targetId: "42",
        targetType: "membership",
        metadata: expect.objectContaining({ roleIds: [10] }),
      }),
    });
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

describe("InvitationCreateService.bulkInvite() — module access (BUG-HRMS-003)", () => {
  interface BulkWrites {
    moduleAccessInserts: Array<{
      orgId: string;
      invitationId: string;
      moduleKey: string;
      standing: string;
    }>;
    moduleAccessDeletes: number;
    invitationInserts: number;
  }

  async function buildHarness(): Promise<{
    service: InvitationCreateService;
    writes: BulkWrites;
  }> {
    const writes: BulkWrites = {
      moduleAccessInserts: [],
      moduleAccessDeletes: 0,
      invitationInserts: 0,
    };

    const tx = {
      execute: jest.fn().mockResolvedValue([]),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            for: jest.fn(() => ({ limit: jest.fn().mockResolvedValue([]) })),
          })),
        })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
      })),
      delete: jest.fn((table: unknown) => {
        if (table === invitationModuleAccess) writes.moduleAccessDeletes += 1;
        return { where: jest.fn().mockResolvedValue(undefined) };
      }),
      insert: jest.fn((table: unknown) => ({
        values: jest.fn((input: unknown) => {
          const rows = Array.isArray(input) ? input : [input];
          if (table === invitationModuleAccess) {
            writes.moduleAccessInserts.push(
              ...(rows as BulkWrites["moduleAccessInserts"]),
            );
          }
          if (table === invitations) {
            writes.invitationInserts += rows.length;
          }
          const returned = (
            rows as Array<{ id?: string; email?: string }>
          ).map((row) => ({ id: row.id ?? "", email: row.email ?? "" }));
          return {
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve(undefined).then(resolve),
            onConflictDoNothing: jest.fn(() => ({
              returning: jest.fn().mockResolvedValue(returned),
            })),
          };
        }),
      })),
    };

    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, run: (handle: typeof tx) => Promise<unknown>) =>
        run(tx),
    );

    const bulkDb = {
      query: {
        organizations: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ name: "Org", status: "ACTIVE", deletedAt: null }),
        },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 17 }) },
      },
    };
    const screenMany = jest.fn(
      (_executor: unknown, input: { emails: string[] }) =>
        Promise.resolve(
          new Map(
            input.emails.map((email) => [
              email,
              { kind: "clear" as const, userId: null },
            ]),
          ),
        ),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationCreateService,
        { provide: DRIZZLE, useValue: bulkDb },
        { provide: AuditService, useValue: { log: jest.fn(), logMany: jest.fn() } },
        {
          provide: CacheService,
          useValue: { invalidateForOrg: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EmailService,
          useValue: {
            queueInvitationEmails: jest.fn((items: readonly unknown[]) =>
              Promise.resolve(items.map(() => ({ queued: true as const }))),
            ),
          },
        },
        {
          provide: PlanLimitsService,
          useValue: {
            headroomFor: jest
              .fn()
              .mockResolvedValue({ limit: null, used: 0, available: null }),
            assertWithinLimit: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SeatLedgerService,
          useValue: { recordSeatEvents: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: AccessService, useValue: {} },
        { provide: MembershipAdmissionService, useValue: { screenMany } },
      ],
    }).compile();

    return { service: moduleRef.get(InvitationCreateService), writes };
  }

  it("the schema accepts module standings on a bulk invite, with the single invite's limits", () => {
    expect(
      bulkInviteSchema.safeParse({ emails: ["a@b.com"], moduleAccess: [{ moduleKey: "hr", standing: "ADMIN" }] }).success,
    ).toBe(true);
    expect(
      bulkInviteSchema.safeParse({
        emails: ["a@b.com"],
        moduleAccess: [{ moduleKey: "hr", standing: "ADMIN" }, { moduleKey: "hr", standing: "MEMBER" }],
      }).success,
    ).toBe(false);
  });

  it("attaches the validated standings to every invitation it creates", async () => {
    const { service, writes } = await buildHarness();
    (resolveModuleStandingRole as jest.Mock).mockResolvedValue(resolvedRole);
    (assertMayAssignRole as jest.Mock).mockResolvedValue(undefined);

    const { results } = await service.bulkInvite(
      ORG_ID,
      actor,
      ["a@b.com", "c@d.com"],
      "MEMBER",
      "enqueue",
      [{ moduleKey: "hr", standing: "ADMIN" }],
    );

    const created = results.filter((row) => row.success);
    expect(created).toHaveLength(2);
    expect(writes.moduleAccessInserts).toEqual(
      created.map((row) => ({
        orgId: ORG_ID,
        invitationId: row.invitationId,
        moduleKey: "hr",
        standing: "ADMIN",
      })),
    );
    expect(assertMayAssignRole).toHaveBeenCalledTimes(1);
  });

  it("clears any standings already attached to a row it reuses, so the insert cannot collide", async () => {
    const { service, writes } = await buildHarness();
    (resolveModuleStandingRole as jest.Mock).mockResolvedValue(resolvedRole);
    (assertMayAssignRole as jest.Mock).mockResolvedValue(undefined);

    await service.bulkInvite(ORG_ID, actor, ["a@b.com"], "MEMBER", "enqueue", [
      { moduleKey: "hr", standing: "ADMIN" },
    ]);

    expect(writes.moduleAccessDeletes).toBe(1);
  });

  it("refuses the whole batch, creating nothing, when the actor may not grant a standing", async () => {
    const { service, writes } = await buildHarness();
    (resolveModuleStandingRole as jest.Mock).mockResolvedValue(resolvedRole);
    (assertMayAssignRole as jest.Mock).mockRejectedValue(new ForbiddenException("not allowed"));

    await expect(
      service.bulkInvite(ORG_ID, actor, ["a@b.com"], "MEMBER", "enqueue", [{ moduleKey: "hr", standing: "ADMIN" }]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(writes.invitationInserts).toBe(0);
    expect(writes.moduleAccessInserts).toEqual([]);
  });

  it("still attaches no standings when none were asked for (positive pair)", async () => {
    const { service, writes } = await buildHarness();

    const { results } = await service.bulkInvite(ORG_ID, actor, ["a@b.com"], "MEMBER");

    expect(results[0]?.success).toBe(true);
    expect(writes.moduleAccessInserts).toEqual([]);
    expect(resolveModuleStandingRole).not.toHaveBeenCalled();
  });
});
