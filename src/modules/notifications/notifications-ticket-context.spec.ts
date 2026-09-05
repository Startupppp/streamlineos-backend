import { Test } from "@nestjs/testing";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { NotificationsReadService } from "./notifications-read.service";
import { NotificationVisibilityRegistry } from "./notification-visibility.registry";
import { listSchema } from "./dto/notification.schemas";
import type { NotificationTicketContext } from "./notifications.types";

const principal = humanSessionPrincipal(7, false);

const context: NotificationTicketContext = {
  ticketId: 11, ticketKey: "SEC-11", priority: "HIGH", status: "TODO", type: "TASK",
  assignee: { id: "assignee", name: "Private person", firstName: null, lastName: null, image: null },
};

describe("notification live ticket context", () => {
  it("batches only page ids and reauthorizes a cache hit after revocation", async () => {
    const registry = new NotificationVisibilityRegistry();
    let permitted = true;
    const resolver = jest.fn(async () => permitted ? new Map([[11, context]]) : new Map<number, NotificationTicketContext>());
    registry.registerTicketContext(resolver);
    const notification = {
      id: 9, orgId: "org-a", userId: "reader", entityType: "ticket", entityId: "11",
      metadata: null, isRead: false, title: "Historical recipient text", message: "Already delivered",
    };
    const limit = jest.fn().mockResolvedValue([notification, { ...notification, id: 8 }]);
    const listQuery = { where: jest.fn(() => ({ orderBy: jest.fn(() => ({ limit })) })) };
    const recipientQuery = { leftJoin: jest.fn(() => ({ where: jest.fn().mockResolvedValue([{ membershipId: 7, lastReadId: 0 }]) })) };
    const select = jest.fn()
      .mockReturnValueOnce({ from: jest.fn(() => recipientQuery) })
      .mockReturnValueOnce({ from: jest.fn(() => listQuery) });
    const cached = new Map<string, unknown>();
    const cachedVersioned = jest.fn(async (namespace: string, key: string, fetch: () => Promise<unknown>) => {
      const fullKey = `${namespace}/${key}`;
      if (!cached.has(fullKey)) cached.set(fullKey, await fetch());
      return cached.get(fullKey);
    });
    const module = await Test.createTestingModule({ providers: [
      NotificationsReadService,
      { provide: DRIZZLE, useValue: { select } },
      { provide: CacheService, useValue: { cachedVersioned } },
      { provide: NotificationVisibilityRegistry, useValue: registry },
    ] }).compile();
    try {
      const service = module.get(NotificationsReadService);
      const first = await service.list("org-a", "reader", listSchema.parse({}), principal);
      expect(first.data.map((row) => row.ticketContext)).toEqual([context, context]);
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(resolver).toHaveBeenCalledWith("org-a", "reader", [11], principal);
      expect(JSON.stringify([...cached.values()])).not.toContain("Private person");
      expect(JSON.stringify([...cached.values()])).not.toContain("ticketContext");

      permitted = false;
      const second = await service.list("org-a", "reader", listSchema.parse({}), principal);
      expect(second.data.map((row) => row.ticketContext)).toEqual([null, null]);
      expect(second.data[0]?.title).toBe("Historical recipient text");
      expect(resolver).toHaveBeenCalledTimes(2);
      expect(select).toHaveBeenCalledTimes(2);
      expect([...cached.keys()][0]).toContain("history-v2:");
      const noPrincipal = await service.list("org-a", "reader", listSchema.parse({}));
      expect(noPrincipal.data.every((row) => row.ticketContext === null)).toBe(true);
      expect(resolver).toHaveBeenCalledTimes(2);
    } finally {
      await module.close();
    }
  });

  it("fails closed when the module resolver is absent or errors", async () => {
    const registry = new NotificationVisibilityRegistry();
    expect((await registry.ticketContexts("org", "user", [11], principal)).size).toBe(0);
    registry.registerTicketContext(async () => { throw new Error("ACL lookup unavailable"); });
    expect((await registry.ticketContexts("org", "user", [11], principal)).size).toBe(0);
  });

  it("deduplicates and bounds a batch without truncating silently", async () => {
    const registry = new NotificationVisibilityRegistry();
    const resolver = jest.fn(async () => new Map([[11, context], [99, { ...context, ticketId: 99 }]]));
    registry.registerTicketContext(resolver);
    expect([...(await registry.ticketContexts("org", "user", [11, 11], principal)).keys()]).toEqual([11]);
    expect(resolver).toHaveBeenCalledWith("org", "user", [11], principal);
    await expect(registry.ticketContexts("org", "user", Array.from({ length: 101 }, (_, i) => i + 1), principal))
      .rejects.toThrow("at most 100");
    await expect(registry.ticketContexts("org", "user", [1.5], principal)).rejects.toThrow("positive integer");
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});
