jest.mock("../../email/app-url", () => ({
  appUrl: "https://test.example.com",
}));

import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AccessService } from "../../access/access.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { EmailService } from "../../email/email.service";
import { InvitationsService } from "./invitations.service";
import { InvitationLifecycleService } from "./invitation-lifecycle.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

describe("InvitationsService state transitions", () => {
  const invitationFindFirst = jest.fn();
  const organizationFindFirst = jest.fn();
  const membershipFindFirst = jest.fn();
  const userFindFirst = jest.fn();
  const invalidate = jest.fn().mockResolvedValue(undefined);
  const invalidatePattern = jest.fn().mockResolvedValue(undefined);
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
  let service: InvitationsService;
  let lifecycle: InvitationLifecycleService;

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
        InvitationsService,
        InvitationLifecycleService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: { invalidate, invalidatePattern, invalidateNamespace },
        },
        {
          provide: EmailService,
          useValue: {
            sendInvitationEmail: jest.fn().mockResolvedValue(undefined),
            sendInvitationRevokedEmail: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: PlanLimitsService, useValue: {} },
        { provide: AccessService, useValue: {} },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = moduleRef.get(InvitationsService);
    lifecycle = moduleRef.get(InvitationLifecycleService);
  });

  it.each(["resend", "cancel"] as const)(
    "returns 404 for a cross-tenant invitation id on %s",
    async (operation) => {
      invitationFindFirst.mockResolvedValue(null);

      const run =
        operation === "resend"
          ? () => service.resend("org-a", "invite-from-org-b", "actor-1")
          : () => lifecycle.cancel("org-a", "invite-from-org-b", "actor-1");

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
      lifecycle.cancel("org-a", "invite-1", "actor-1"),
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
          ? () => service.resend("org-a", "invite-1", "actor-1")
          : () => lifecycle.cancel("org-a", "invite-1", "actor-1");

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
      lifecycle.changeRole(
        "org-a",
        "invite-1",
        { userId: "actor-1", isOrgOwner: true },
        "ORG_ADMIN",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(eventValues).not.toHaveBeenCalled();
  });
});
