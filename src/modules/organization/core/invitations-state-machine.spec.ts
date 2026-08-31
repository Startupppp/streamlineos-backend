jest.mock("../../email/app-url", () => ({
  appUrl: "https://test.example.com",
}));

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AccessService } from "../../access/access.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { EmailService } from "../../email/email.service";
import { InvitationCreateService } from "./invitation-create.service";
import { InvitationLifecycleService } from "./invitation-lifecycle.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

describe("Invitation sub-services state transitions", () => {
  const invitationFindFirst = jest.fn();
  const organizationFindFirst = jest.fn();
  const membershipFindFirst = jest.fn();
  const userFindFirst = jest.fn();
  const canManageOrganizationMembership = jest.fn().mockResolvedValue(true);
  const invalidate = jest.fn().mockResolvedValue(undefined);
  const invalidateNamespace = jest.fn().mockResolvedValue(undefined);
  const updateReturning = jest.fn().mockResolvedValue([{ id: "invite-1" }]);
  const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
  const eventValues = jest.fn().mockResolvedValue(undefined);
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: updateWhere }),
    }),
    insert: jest.fn().mockReturnValue({ values: eventValues }),
  };
  const db = {
    query: {
      invitations: { findFirst: invitationFindFirst },
      organizations: { findFirst: organizationFindFirst },
      organizationMembers: { findFirst: membershipFindFirst },
      users: { findFirst: userFindFirst },
    },
    transaction: jest.fn(
      (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
    ),
  };
  let service: Pick<InvitationLifecycleService, "resend" | "cancel" | "changeRole"> & Pick<InvitationCreateService, "invite" | "bulkInvite">;

  beforeEach(async () => {
    jest.clearAllMocks();
    organizationFindFirst.mockResolvedValue({
      id: "org-a",
      name: "Alpha",
      status: "ACTIVE",
      deletedAt: null,
      allowedEmailDomains: [],
    });
    membershipFindFirst.mockResolvedValue({ id: 7 });
    userFindFirst.mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationCreateService,
        InvitationLifecycleService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: {
            invalidate,
            invalidateNamespace,
            invalidateForOrg: (o: string, k: string) => invalidate(`${o}:${k}`),
            invalidateNamespaceForOrg: (o: string, n: string) => invalidateNamespace(`${o}:${n}`),
          },
        },
        {
          provide: EmailService,
          useValue: {
            sendInvitationEmail: jest.fn().mockResolvedValue(undefined),
            sendInvitationRevokedEmail: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: PlanLimitsService, useValue: {} },
        { provide: SeatLedgerService, useValue: { recordSeatEvent: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: AccessService,
          useValue: { canManageOrganizationMembership },
        },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    const lifecycle = moduleRef.get(InvitationLifecycleService);
    const create = moduleRef.get(InvitationCreateService);
    service = {
      resend: lifecycle.resend.bind(lifecycle),
      cancel: lifecycle.cancel.bind(lifecycle),
      changeRole: lifecycle.changeRole.bind(lifecycle),
      invite: create.invite.bind(create),
      bulkInvite: create.bulkInvite.bind(create),
    };
  });

  it.each(["resend", "cancel"] as const)(
    "returns 404 for a cross-tenant invitation id on %s",
    async (operation) => {
      invitationFindFirst.mockResolvedValue(null);

      const run =
        operation === "resend"
          ? () =>
              service.resend("org-a", "invite-from-org-b", {
                userId: "actor-1",
                isOrgOwner: false,
              })
          : () =>
              service.cancel("org-a", "invite-from-org-b", {
                userId: "actor-1",
                isOrgOwner: false,
              });

      await expect(run()).rejects.toBeInstanceOf(NotFoundException);
      expect(db.transaction).not.toHaveBeenCalled();
    },
  );

  it("cancels pending invitations transactionally and busts user statistics", async () => {
    invitationFindFirst.mockResolvedValue({
      id: "invite-1",
      orgId: "org-a",
      email: "member@example.com",
      status: "PENDING",
      acceptedAt: null,
    });

    await expect(
      service.cancel("org-a", "invite-1", {
        userId: "actor-1",
        isOrgOwner: false,
      }),
    ).resolves.toEqual({ success: true });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(eventValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-a",
        invitationId: "invite-1",
        event: "REVOKED",
      }),
    );
    expect(invalidate).toHaveBeenCalled();
  });

  it.each(["resend", "cancel"] as const)(
    "does not append an event when a concurrent transition wins before %s",
    async (operation) => {
      invitationFindFirst.mockResolvedValue({
        id: "invite-1",
        orgId: "org-a",
        email: "member@example.com",
        status: "PENDING",
        acceptedAt: null,
      });
      updateReturning.mockResolvedValueOnce([]);

      const run =
        operation === "resend"
          ? () =>
              service.resend("org-a", "invite-1", {
                userId: "actor-1",
                isOrgOwner: false,
              })
          : () =>
              service.cancel("org-a", "invite-1", {
                userId: "actor-1",
                isOrgOwner: false,
              });

      await expect(run()).rejects.toBeInstanceOf(NotFoundException);

      expect(eventValues).not.toHaveBeenCalled();
    },
  );

  it("does not append a role-change event when a concurrent transition wins", async () => {
    invitationFindFirst.mockResolvedValue({
      id: "invite-1",
      orgId: "org-a",
      email: "member@example.com",
      role: "MEMBER",
      status: "PENDING",
      acceptedAt: null,
    });
    updateReturning.mockResolvedValueOnce([]);

    await expect(
      service.changeRole(
        "org-a",
        "invite-1",
        { userId: "actor-1", isOrgOwner: true },
        "ORG_ADMIN",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(eventValues).not.toHaveBeenCalled();
  });

  it.each(["resend", "cancel", "change-role"] as const)(
    "rejects %s when a custom settings grant lacks structural membership authority",
    async (operation) => {
      invitationFindFirst.mockResolvedValue({
        id: "invite-1",
        orgId: "org-a",
        email: "member@example.com",
        role: "MEMBER",
        status: "PENDING",
        acceptedAt: null,
      });
      canManageOrganizationMembership.mockResolvedValueOnce(false);
      const actor = { userId: "custom-manager", isOrgOwner: false };

      const run =
        operation === "resend"
          ? () => service.resend("org-a", "invite-1", actor)
          : operation === "cancel"
            ? () => service.cancel("org-a", "invite-1", actor)
            : () =>
                service.changeRole(
                  "org-a",
                  "invite-1",
                  actor,
                  "ORG_ADMIN",
                );

      await expect(run()).rejects.toBeInstanceOf(ForbiddenException);
      expect(db.transaction).not.toHaveBeenCalled();
    },
  );

  it.each(["invite", "bulk-invite"] as const)(
    "rejects %s before reading organization data when structural authority is absent",
    async (operation) => {
      canManageOrganizationMembership.mockResolvedValueOnce(false);
      const actor = { userId: "custom-manager", isOrgOwner: false };

      const run =
        operation === "invite"
          ? () =>
              service.invite(
                "org-a",
                actor,
                "member@example.com",
                "MEMBER",
              )
          : () =>
              service.bulkInvite(
                "org-a",
                actor,
                ["member@example.com"],
                "MEMBER",
              );

      await expect(run()).rejects.toBeInstanceOf(ForbiddenException);
      expect(organizationFindFirst).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    },
  );
});
