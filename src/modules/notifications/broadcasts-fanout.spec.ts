/**
 * C21-02 — Fan-out-on-read for broadcasts.
 *
 * Central assertions:
 *   • publish() writes exactly ONE row (the broadcast status update) regardless
 *     of audience size — no per-user notification rows.
 *   • The dispatch pipeline is called for non-IN_APP channels so preferences,
 *     quiet hours and email all apply.
 *   • dismiss() is durable and idempotent: calling it twice produces one receipt.
 *   • viewerCount() counts receipts, not notification rows.
 */

import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { broadcasts } from "../../db/schema";
import { BroadcastsService } from "./broadcasts.service";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const ORG = "org-c21-0000-0000-0000-000000000002";
const ACTOR = "user-c21-0000-0000-0000-000000000001";
const USER_A = "user-c21-0000-0000-0000-000000000002";
const USER_B = "user-c21-0000-0000-0000-000000000003";

const mockCache = {
  cachedVersioned: jest.fn(),
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
};
const mockAudit = { log: jest.fn() };

function makeBroadcast(overrides: Partial<ReturnType<typeof baseBroadcast>> = {}) {
  return { ...baseBroadcast(), ...overrides };
}

function baseBroadcast(): typeof broadcasts.$inferSelect {
  return {
    id: 42,
    orgId: ORG,
    title: "Company Update",
    message: "Please read the attached policy.",
    type: "INFO" as const,
    priority: "NORMAL" as const,
    category: "SYSTEM" as const,
    channels: ["IN_APP", "EMAIL"] as string[],
    audience: { type: "all" as const },
    audienceType: "all" as const,
    status: "DRAFT",
    scheduledAt: null,
    sentAt: null,
    recipientCount: 0,
    deliveredCount: 0,
    createdBy: ACTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeDb() {
  const selectChain = {
    from: jest.fn(),
  };
  const db = {
    query: { broadcasts: { findFirst: jest.fn() } },
    select: jest.fn().mockReturnValue(selectChain),
    update: jest.fn(),
    insert: jest.fn(),
  };
  selectChain.from.mockReturnValue({
    where: jest.fn().mockReturnValue({
      then: jest.fn().mockImplementation((fn) => fn([])),
    }),
    innerJoin: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue([]),
    }),
    leftJoin: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    orderBy: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([]),
    }),
  });
  return db;
}

describe("BroadcastsService — C21-02 fan-out-on-read", () => {
  let svc: BroadcastsService;
  let db: ReturnType<typeof makeDb>;
  let dispatch: { emit: jest.Mock };

  beforeEach(async () => {
    jest.resetAllMocks();
    db = makeDb();
    dispatch = { emit: jest.fn().mockResolvedValue({ notified: 0, deferred: true }) };

    const module = await Test.createTestingModule({
      providers: [
        BroadcastsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: mockCache },
        { provide: AuditService, useValue: mockAudit },
        { provide: NotificationDispatchService, useValue: dispatch },
      ],
    }).compile();

    svc = module.get(BroadcastsService);
  });

  describe("publish — row count", () => {
    function setupMembers(userIds: string[]) {
      const from = jest.fn();
      db.select.mockReturnValue({ from });
      from.mockImplementation(() => ({
        where: jest.fn().mockResolvedValue(userIds.map((userId) => ({ userId }))),
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(userIds.map((userId) => ({ userId }))),
        }),
      }));
    }

    function setupBroadcastUpdate(broadcast: ReturnType<typeof baseBroadcast>) {
      const sentRow = { ...broadcast, status: "SENT" as const, recipientCount: 0, deliveredCount: 0 };
      db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([sentRow]),
          }),
        }),
      });
    }

    it("writes exactly one row (the status update) for a 50 000-member audience — zero notification rows", async () => {
      const largeMemberList = Array.from({ length: 50_000 }, (_, i) =>
        `user-${String(i).padStart(8, "0")}`,
      );
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP"] }));
      setupMembers(largeMemberList);
      setupBroadcastUpdate(baseBroadcast());

      await svc.publish(ORG, ACTOR, 42);

      expect(db.update).toHaveBeenCalledTimes(1);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("calls dispatch.emit for EMAIL channel and passes all resolved recipients", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP", "EMAIL"] }));
      setupMembers([USER_A, USER_B]);
      setupBroadcastUpdate(baseBroadcast());

      await svc.publish(ORG, ACTOR, 42);

      expect(dispatch.emit).toHaveBeenCalledTimes(1);
      const call = dispatch.emit.mock.calls[0][0];
      expect(call.eventKey).toBe("notification.broadcast.published");
      expect(call.targetUserIds).toEqual(expect.arrayContaining([USER_A, USER_B]));
      expect(call.targetUserIds).toHaveLength(2);
    });

    it("does NOT call dispatch.emit when the broadcast has only IN_APP channel", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP"] }));
      setupMembers([USER_A]);
      setupBroadcastUpdate(baseBroadcast());

      await svc.publish(ORG, ACTOR, 42);

      expect(dispatch.emit).not.toHaveBeenCalled();
    });

    it("does NOT call dispatch.emit when the audience is empty", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP", "EMAIL"] }));
      setupMembers([]);
      setupBroadcastUpdate(baseBroadcast());

      await svc.publish(ORG, ACTOR, 42);

      expect(dispatch.emit).not.toHaveBeenCalled();
    });

    it("sets deliveredCount to 0 on the broadcast row (not recipientCount)", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP"] }));
      setupMembers([USER_A, USER_B]);

      const returning = jest.fn().mockResolvedValue([{ ...baseBroadcast(), status: "SENT", deliveredCount: 0 }]);
      const where = jest.fn().mockReturnValue({ returning });
      const set = jest.fn().mockReturnValue({ where });
      db.update.mockReturnValue({ set });

      await svc.publish(ORG, ACTOR, 42);

      const setArgs = set.mock.calls[0][0];
      expect(setArgs.deliveredCount).toBe(0);
      expect(setArgs.recipientCount).toBe(2);
    });

    it("throws BadRequestException when the broadcast cannot be found after update", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP"] }));
      setupMembers([USER_A]);
      db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      await expect(svc.publish(ORG, ACTOR, 42)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws NotFoundException when the broadcast does not belong to the org", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(undefined);

      await expect(svc.publish(ORG, ACTOR, 42)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("dismiss — idempotency", () => {
    it("inserts a receipt row on the first call", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ status: "SENT" as const }));
      const onConflictDoNothing = jest.fn().mockResolvedValue([]);
      const values = jest.fn().mockReturnValue({ onConflictDoNothing });
      db.insert.mockReturnValue({ values });

      const result = await svc.dismiss(ORG, USER_A, 42);

      expect(result).toEqual({ success: true });
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG, broadcastId: 42, userId: USER_A }),
      );
      expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    });

    it("does not throw on repeated calls — onConflictDoNothing absorbs the duplicate", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ status: "SENT" as const }));
      const onConflictDoNothing = jest.fn().mockResolvedValue([]);
      db.insert.mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoNothing }) });

      await svc.dismiss(ORG, USER_A, 42);
      await svc.dismiss(ORG, USER_A, 42);

      expect(db.insert).toHaveBeenCalledTimes(2);
      expect(onConflictDoNothing).toHaveBeenCalledTimes(2);
    });

    it("performs a BOLA check: throws NotFoundException for a foreign-org broadcast", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(undefined);

      await expect(svc.dismiss(ORG, USER_A, 42)).rejects.toBeInstanceOf(NotFoundException);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe("viewerCount", () => {
    it("returns the count of receipt rows from the DB", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ status: "SENT" as const }));
      db.select.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ count: 17 }]),
        }),
      });

      const result = await svc.viewerCount(ORG, 42);

      expect(result).toEqual({ broadcastId: 42, viewerCount: 17 });
    });

    it("returns 0 when no receipts exist", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ status: "SENT" as const }));
      db.select.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      });

      const result = await svc.viewerCount(ORG, 42);

      expect(result).toEqual({ broadcastId: 42, viewerCount: 0 });
    });
  });
});
