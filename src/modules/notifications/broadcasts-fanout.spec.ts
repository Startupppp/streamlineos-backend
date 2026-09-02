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

const PAGE_SIZE = 500;

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

/** Wires db.select to return paged results from the given userId list for audienceType="all". */
function setupMembers(userIds: string[], db: ReturnType<typeof makeDb>) {
  const firstPage = userIds
    .slice(0, PAGE_SIZE)
    .map((userId, i) => ({ userId, id: i + 1 }));
  const limitFn = jest.fn().mockResolvedValueOnce(firstPage).mockResolvedValue([]);
  const orderByFn = jest.fn().mockReturnValue({ limit: limitFn });
  const whereFn = jest.fn().mockReturnValue({ orderBy: orderByFn });
  const fromFn = jest.fn().mockReturnValue({ where: whereFn });
  db.select.mockReturnValue({ from: fromFn });
  return { limitFn, orderByFn, whereFn };
}

function setupBroadcastUpdate(broadcast: ReturnType<typeof baseBroadcast>, db: ReturnType<typeof makeDb>) {
  const sentRow = { ...broadcast, status: "SENT" as const, recipientCount: 0, deliveredCount: 0 };
  db.update.mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([sentRow]),
      }),
    }),
  });
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
    it("writes exactly one row (the status update) for a large audience — zero notification rows", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP"] }));
      setupMembers(Array.from({ length: 50_000 }, (_, i) => `user-${String(i).padStart(8, "0")}`), db);
      setupBroadcastUpdate(baseBroadcast(), db);

      await svc.publish(ORG, ACTOR, 42);

      expect(db.update).toHaveBeenCalledTimes(1);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("calls dispatch.emit for EMAIL channel and passes all resolved recipients", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP", "EMAIL"] }));
      setupMembers([USER_A, USER_B], db);
      setupBroadcastUpdate(baseBroadcast(), db);

      await svc.publish(ORG, ACTOR, 42);

      expect(dispatch.emit).toHaveBeenCalledTimes(1);
      const call = dispatch.emit.mock.calls[0]?.[0];
      expect(call?.eventKey).toBe("notification.broadcast.published");
      expect(call?.targetUserIds).toEqual(expect.arrayContaining([USER_A, USER_B]));
      expect(call?.targetUserIds).toHaveLength(2);
    });

    it("does NOT call dispatch.emit when the broadcast has only IN_APP channel", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP"] }));
      setupMembers([USER_A], db);
      setupBroadcastUpdate(baseBroadcast(), db);

      await svc.publish(ORG, ACTOR, 42);

      expect(dispatch.emit).not.toHaveBeenCalled();
    });

    it("does NOT call dispatch.emit when the audience is empty", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP", "EMAIL"] }));
      setupMembers([], db);
      setupBroadcastUpdate(baseBroadcast(), db);

      await svc.publish(ORG, ACTOR, 42);

      expect(dispatch.emit).not.toHaveBeenCalled();
    });

    it("sets deliveredCount to 0 on the broadcast row (not recipientCount)", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP"] }));
      setupMembers([USER_A, USER_B], db);

      const returning = jest.fn().mockResolvedValue([{ ...baseBroadcast(), status: "SENT", deliveredCount: 0 }]);
      const where = jest.fn().mockReturnValue({ returning });
      const set = jest.fn().mockReturnValue({ where });
      db.update.mockReturnValue({ set });

      await svc.publish(ORG, ACTOR, 42);

      const setArgs = set.mock.calls[0]?.[0];
      expect(setArgs?.deliveredCount).toBe(0);
      expect(setArgs?.recipientCount).toBe(2);
    });

    it("throws BadRequestException when the broadcast cannot be found after update", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP"] }));
      setupMembers([USER_A], db);
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

  describe("publish — bounded DB access pattern", () => {
    it("queries the DB at most PAGE_SIZE rows per call (bounded limit)", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP"] }));
      const { limitFn } = setupMembers([USER_A], db);
      setupBroadcastUpdate(baseBroadcast(), db);

      await svc.publish(ORG, ACTOR, 42);

      expect(limitFn).toHaveBeenCalledWith(PAGE_SIZE);
    });

    it("issues a second DB query when the first page is exactly PAGE_SIZE, and stops when the next is empty", async () => {
      const allUsers = Array.from({ length: PAGE_SIZE }, (_, i) => `user-${i}`);
      const page1 = allUsers.map((userId, i) => ({ userId, id: i + 1 }));

      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["EMAIL"] }));

      const limitFn = jest.fn().mockResolvedValueOnce(page1).mockResolvedValue([]);
      const orderByFn = jest.fn().mockReturnValue({ limit: limitFn });
      const whereFn = jest.fn().mockReturnValue({ orderBy: orderByFn });
      db.select.mockReturnValue({ from: jest.fn().mockReturnValue({ where: whereFn }) });

      db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ ...baseBroadcast(), status: "SENT" }]),
          }),
        }),
      });

      await svc.publish(ORG, ACTOR, 42);

      expect(limitFn).toHaveBeenCalledTimes(2);
      expect(limitFn).toHaveBeenCalledWith(PAGE_SIZE);
      expect(whereFn).toHaveBeenCalledTimes(2);
    });

    it("union of dispatched pages equals the full recipient set — no dups, none dropped", async () => {
      const allUsers = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => `user-${i}`);
      const page1 = allUsers.slice(0, PAGE_SIZE).map((userId, i) => ({ userId, id: i + 1 }));
      const page2 = allUsers.slice(PAGE_SIZE).map((userId, i) => ({ userId, id: PAGE_SIZE + i + 1 }));

      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["EMAIL"] }));

      const limitFn = jest.fn()
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2)
        .mockResolvedValue([]);
      const orderByFn = jest.fn().mockReturnValue({ limit: limitFn });
      const whereFn = jest.fn().mockReturnValue({ orderBy: orderByFn });
      db.select.mockReturnValue({ from: jest.fn().mockReturnValue({ where: whereFn }) });

      db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ ...baseBroadcast(), status: "SENT" }]),
          }),
        }),
      });

      await svc.publish(ORG, ACTOR, 42);

      const allDispatched = dispatch.emit.mock.calls.flatMap(
        ([args]: [{ targetUserIds: string[] }]) => args.targetUserIds,
      );
      expect(allDispatched).toHaveLength(allUsers.length);
      expect(new Set(allDispatched).size).toBe(allUsers.length);
      expect(new Set(allDispatched)).toEqual(new Set(allUsers));
    });

    it("WHERE clause differs between pages — advancing cursor (two calls, two distinct where invocations)", async () => {
      const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => ({ userId: `user-${i}`, id: i + 1 }));

      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ channels: ["IN_APP"] }));

      const capturedArgs: unknown[] = [];
      const limitFn = jest.fn().mockResolvedValueOnce(page1).mockResolvedValue([]);
      const orderByFn = jest.fn().mockReturnValue({ limit: limitFn });
      const whereFn = jest.fn().mockImplementation((...args) => {
        capturedArgs.push(args);
        return { orderBy: orderByFn };
      });
      db.select.mockReturnValue({ from: jest.fn().mockReturnValue({ where: whereFn }) });

      db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ ...baseBroadcast(), status: "SENT" }]),
          }),
        }),
      });

      await svc.publish(ORG, ACTOR, 42);

      expect(whereFn).toHaveBeenCalledTimes(2);
      expect(capturedArgs[0]).not.toStrictEqual(capturedArgs[1]);
    });
  });

  describe("dismiss — idempotency", () => {
    it("inserts a receipt row on the first call", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ status: "SENT" as const }));
      const onConflictDoNothing = jest.fn().mockResolvedValue([]);
      const values = jest.fn().mockReturnValue({ onConflictDoNothing });
      db.insert.mockReturnValue({ values });

      const result = await svc.dismiss(ORG, USER_A, 42, 7);

      expect(result).toEqual({ success: true });
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG, broadcastId: 42, membershipId: 7 }),
      );
      expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    });

    it("does not throw on repeated calls — onConflictDoNothing absorbs the duplicate", async () => {
      db.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast({ status: "SENT" as const }));
      const onConflictDoNothing = jest.fn().mockResolvedValue([]);
      db.insert.mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoNothing }) });

      await svc.dismiss(ORG, USER_A, 42, 7);
      await svc.dismiss(ORG, USER_A, 42, 7);

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
