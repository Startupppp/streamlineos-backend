import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { InvitationAcceptanceService } from "./invitation-acceptance.service";

const PENDING_INVITATION = {
  id: "invite-1",
  orgId: "org-a",
  email: "invitee@example.com",
  role: "MEMBER",
  invitedBy: "inviter-1",
  status: "PENDING" as const,
  acceptedAt: null,
};

describe("InvitationAcceptanceService.decline", () => {
  const invitationFindFirst = jest.fn();
  const updateReturning = jest.fn();
  const eventValues = jest.fn().mockResolvedValue(undefined);
  const adminSelectWhere = jest.fn();
  const emit = jest.fn();

  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: updateReturning }),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values: eventValues }),
    query: { invitations: { findFirst: invitationFindFirst } },
  };

  const db = {
    query: { invitations: { findFirst: invitationFindFirst } },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: adminSelectWhere }),
    }),
    transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  let svc: InvitationAcceptanceService;

  beforeEach(async () => {
    jest.clearAllMocks();
    invitationFindFirst.mockResolvedValue(PENDING_INVITATION);
    updateReturning.mockResolvedValue([{ id: "invite-1" }]);
    adminSelectWhere.mockResolvedValue([{ userId: "owner-1" }]);
    emit.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationAcceptanceService,
        { provide: DRIZZLE, useValue: db },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
        { provide: SeatLedgerService, useValue: { recordSeatEvent: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NotificationDispatchService, useValue: { emit } },
      ],
    }).compile();

    svc = moduleRef.get(InvitationAcceptanceService);
  });

  async function flushPendingNotifications(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("marks the invitation DECLINED and records a DECLINED event", async () => {
    await expect(svc.decline({ token: "raw-token" })).resolves.toEqual({ ok: true });

    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(eventValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-a",
        invitationId: "invite-1",
        event: "DECLINED",
      }),
    );
  });

  it("notifies the inviter and org admins", async () => {
    adminSelectWhere.mockResolvedValue([{ userId: "owner-1" }, { userId: "admin-2" }]);

    await svc.decline({ token: "raw-token" });
    await flushPendingNotifications();

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "organization.invitation.declined",
        orgId: "org-a",
        targetUserIds: expect.arrayContaining(["owner-1", "admin-2", "inviter-1"]),
      }),
    );
  });

  it("returns 404 for an invalid or already-terminal token", async () => {
    invitationFindFirst.mockResolvedValue(undefined);

    await expect(svc.decline({ token: "raw-token" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not append an event when a concurrent transition wins the update", async () => {
    updateReturning.mockResolvedValue([]);

    await expect(svc.decline({ token: "raw-token" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(eventValues).not.toHaveBeenCalled();
  });

  it("still succeeds when notification dispatch fails", async () => {
    emit.mockRejectedValue(new Error("dispatch down"));

    await expect(svc.decline({ token: "raw-token" })).resolves.toEqual({ ok: true });
    await flushPendingNotifications();
  });
});
