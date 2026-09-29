import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import {
  SEAT_EVENT_DELTAS,
  seatCount,
  type SeatEventType,
} from "../../billing/core/seat-definition";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import { EmailService } from "../../email/email.service";
import { InvitationAcceptanceService } from "./invitation-acceptance.service";
import { InvitationLifecycleService } from "./invitation-lifecycle.service";
import {
  expiredByTimePredicate,
  openAdminInvitationFilter,
} from "./invitations.helpers";

const dialect = new PgDialect();

const ORG_ID = "org-decline-seat";
const INVITATION_ID = "inv-decline-seat-1";

const PENDING_INVITATION = {
  id: INVITATION_ID,
  orgId: ORG_ID,
  email: "invitee@example.com",
  role: "MEMBER",
  inviterMembershipId: 11,
  status: "PENDING" as const,
  acceptedAt: null,
};

function netLedger(sequence: readonly SeatEventType[]): number {
  return sequence.reduce((total, eventType) => total + SEAT_EVENT_DELTAS[eventType], 0);
}

function requireSql(value: SQL<unknown> | undefined): SQL<unknown> {
  if (value === undefined) throw new Error("expected a rendered SQL predicate");
  return value;
}

describe("seat release on decline — live authority versus the event ledger", () => {
  describe("seatCount is the live authority and it drops a DECLINED row immediately", () => {
    it("admits an invitation only while its status is PENDING", () => {
      const rendered = dialect.sqlToQuery(seatCount(ORG_ID));

      expect(rendered.sql).toContain("FROM invitations");
      expect(rendered.sql).toContain("status = 'PENDING'");
      expect(rendered.sql).toContain("accepted_at IS NULL");
      expect(rendered.sql).toContain("expires_at > NOW()");
    });

    it("never consults declined_at, so the release is the status change itself", () => {
      const rendered = dialect.sqlToQuery(seatCount(ORG_ID));

      expect(rendered.sql).not.toContain("declined_at");
      expect(rendered.sql).not.toContain("'DECLINED'");
    });

    it("counts members and live invitations against one org parameter", () => {
      const rendered = dialect.sqlToQuery(seatCount(ORG_ID));

      expect(rendered.params).toEqual([ORG_ID, ORG_ID]);
    });
  });

  describe("InvitationAcceptanceService.decline", () => {
    const invitationFindFirst = jest.fn();
    const memberFindFirst = jest.fn();
    const updateReturning = jest.fn();
    const updateSet = jest.fn();
    const updateWhere = jest.fn();
    const eventValues = jest.fn().mockResolvedValue(undefined);
    const adminSelectLimit = jest.fn();
    const emit = jest.fn();
    const recordSeatEvent = jest.fn().mockResolvedValue(undefined);
    const recordSeatEvents = jest.fn().mockResolvedValue(undefined);

    const tx = {
      execute: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockReturnValue({ set: updateSet }),
      insert: jest.fn().mockReturnValue({ values: eventValues }),
      query: {
        invitations: { findFirst: invitationFindFirst },
        organizationMembers: { findFirst: memberFindFirst },
      },
    };

    const db = {
      query: {
        invitations: { findFirst: invitationFindFirst },
        organizationMembers: { findFirst: memberFindFirst },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn(() => ({
            orderBy: jest.fn().mockReturnValue({ limit: adminSelectLimit }),
          })),
        }),
      }),
      transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };

    let svc: InvitationAcceptanceService;

    beforeEach(async () => {
      jest.clearAllMocks();
      invitationFindFirst.mockResolvedValue(PENDING_INVITATION);
      memberFindFirst.mockResolvedValue({ userId: "inviter-1" });
      updateReturning.mockResolvedValue([{ id: INVITATION_ID }]);
      updateWhere.mockReturnValue({ returning: updateReturning });
      updateSet.mockReturnValue({ where: updateWhere });
      adminSelectLimit.mockResolvedValue([{ userId: "owner-1" }]);
      emit.mockResolvedValue(undefined);

      const moduleRef = await Test.createTestingModule({
        providers: [
          InvitationAcceptanceService,
          { provide: DRIZZLE, useValue: db },
          { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
          { provide: SeatLedgerService, useValue: { recordSeatEvent, recordSeatEvents } },
          {
            provide: CacheService,
            useValue: {
              invalidate: jest.fn().mockResolvedValue(undefined),
              invalidateForOrg: jest.fn().mockResolvedValue(undefined),
              invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
              invalidateNamespace: jest.fn().mockResolvedValue(undefined),
            },
          },
          { provide: NotificationDispatchService, useValue: { emit } },
          { provide: EmailService, useValue: { sendInvitationEmail: jest.fn().mockResolvedValue(undefined) } },
          { provide: AuditService, useValue: { log: jest.fn() } },
          { provide: AccessService, useValue: { resolveUserPermissions: jest.fn().mockResolvedValue({}) } },
        ],
      }).compile();

      svc = moduleRef.get(InvitationAcceptanceService);
    });

    it("moves the row out of PENDING, which is what releases the live seat", async () => {
      await expect(svc.decline({ token: "raw-token" })).resolves.toEqual({ ok: true });

      expect(updateSet).toHaveBeenCalledTimes(1);
      const applied = updateSet.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(applied?.["status"]).toBe("DECLINED");
      expect(applied?.["declinedAt"]).toBeInstanceOf(Date);
    });

    it("transitions only from PENDING with no acceptance, so a raced accept wins", async () => {
      await svc.decline({ token: "raw-token" });

      const condition = updateWhere.mock.calls[0]?.[0];
      expect(condition).toBeDefined();
      const rendered = dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
      expect(rendered.sql).toContain("accepted_at");
      expect(rendered.params).toContain("PENDING");
      expect(rendered.params).toContain(INVITATION_ID);
    });

    it("releases the reserved seat with a single INVITE_CANCELLED event", async () => {
      await svc.decline({ token: "raw-token" });

      expect(recordSeatEvent).toHaveBeenCalledTimes(1);
      expect(recordSeatEvents).not.toHaveBeenCalled();
      expect(recordSeatEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: ORG_ID,
          eventType: "INVITE_CANCELLED",
          subjectId: INVITATION_ID,
          idempotencyKey: `invite-declined:${INVITATION_ID}`,
        }),
        expect.anything(),
      );
    });

    it("appends the DECLINED invitation event and a release billing can net against", async () => {
      await svc.decline({ token: "raw-token" });

      expect(eventValues).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: ORG_ID,
          invitationId: INVITATION_ID,
          event: "DECLINED",
        }),
      );
      const [event] = recordSeatEvent.mock.calls[0] as [{ eventType: string }];
      expect(SEAT_EVENT_DELTAS[event.eventType as SeatEventType]).toBe(-1);
    });

    it("records the release on the same transaction that declined the invitation", async () => {
      await svc.decline({ token: "raw-token" });

      expect(updateSet).toHaveBeenCalledTimes(1);
      expect(updateSet.mock.invocationCallOrder[0]).toBeLessThan(
        recordSeatEvent.mock.invocationCallOrder[0] ?? 0,
      );
    });
  });

  describe("the compensating -1 can never arrive later", () => {
    it("the expiry sweep only transitions rows that are still PENDING", () => {
      const predicate = expiredByTimePredicate(new Date());
      expect(predicate).toBeDefined();
      const rendered = dialect.sqlToQuery(requireSql(predicate));

      expect(rendered.params).toContain("PENDING");
      expect(rendered.sql).toContain("accepted_at");
    });

    it("the admin cancel path that owns INVITE_CANCELLED also requires PENDING", () => {
      const rendered = dialect.sqlToQuery(
        requireSql(openAdminInvitationFilter(INVITATION_ID, ORG_ID)),
      );

      expect(rendered.params).toContain("PENDING");
      expect(rendered.params).toContain(INVITATION_ID);
      expect(rendered.params).toContain(ORG_ID);
    });

    it("cancelling a declined invitation is a 404 that records no release event", async () => {
      const recordSeatEvent = jest.fn().mockResolvedValue(undefined);
      const db = {
        query: {
          invitations: { findFirst: jest.fn().mockResolvedValue(undefined) },
          organizations: { findFirst: jest.fn().mockResolvedValue(null) },
          organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
          users: { findFirst: jest.fn().mockResolvedValue(null) },
        },
        transaction: jest.fn(),
      };

      const svc = new InvitationLifecycleService(
        db as never,
        { log: jest.fn() } as never,
        { invalidateForOrg: jest.fn().mockResolvedValue(undefined) } as never,
        { sendInvitationRevokedEmail: jest.fn().mockResolvedValue(undefined) } as never,
        { assertWithinLimit: jest.fn() } as never,
        { recordSeatEvent } as never,
        { canManageOrganizationMembership: jest.fn().mockResolvedValue(true) } as never,
      );

      await expect(
        svc.cancel(ORG_ID, INVITATION_ID, { userId: "actor-1", isOrgOwner: true }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(recordSeatEvent).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe("net ledger walk against SEAT_EVENT_DELTAS", () => {
    it("sent -> expired -> resent -> accepted nets one seat, matching one live member", () => {
      expect(
        netLedger(["INVITE_SENT", "INVITE_EXPIRED", "INVITE_SENT", "INVITE_ACCEPTED"]),
      ).toBe(1);
    });

    it("sent -> revoked nets zero, matching zero live seats", () => {
      expect(netLedger(["INVITE_SENT", "INVITE_CANCELLED"])).toBe(0);
    });

    it("sent -> declined nets zero, matching zero live seats", () => {
      const liveSeatsAfterDecline = 0;
      const ledgerAfterDecline = netLedger(["INVITE_SENT", "INVITE_CANCELLED"]);

      expect(ledgerAfterDecline).toBe(0);
      expect(liveSeatsAfterDecline - ledgerAfterDecline).toBe(0);
    });

    it("INVITE_CANCELLED is the existing release delta the decline path reuses", () => {
      expect(SEAT_EVENT_DELTAS.INVITE_CANCELLED).toBe(-1);
      expect(netLedger(["INVITE_SENT", "INVITE_CANCELLED"])).toBe(0);
    });

    it("sent -> expired -> re-invited nets one, matching the one live invitation", () => {
      expect(netLedger(["INVITE_SENT", "INVITE_EXPIRED", "INVITE_SENT"])).toBe(1);
    });

    it("no existing event type releases a seat by any other delta", () => {
      const releasing = Object.entries(SEAT_EVENT_DELTAS)
        .filter(([, delta]) => delta === -1)
        .map(([eventType]) => eventType)
        .sort();

      expect(releasing).toEqual([
        "GUEST_REMOVED",
        "INVITE_CANCELLED",
        "INVITE_EXPIRED",
        "MEMBER_DEACTIVATED",
      ]);
    });
  });
});
