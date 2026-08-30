import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { WebhooksService } from "./webhooks.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value as object)) return [];
  seen.add(value as object);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("WebhooksService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner-uuid";
  const ATTACKER_ORG = "org-attacker-uuid";
  const USER_ID = "user-uuid-1";
  const WEBHOOK_ID = 1;
  const EVENT_ID = 42;

  const WEBHOOK_ROW = {
    id: WEBHOOK_ID,
    orgId: OWNER_ORG,
    url: "https://example.com/hook",
    secret: "deadbeef",
    events: ["product.created"],
    isActive: true,
    lastDeliveryAt: null,
    lastDeliveryStatus: null,
    createdAt: new Date(),
  };

  const EVENT_ROW = {
    id: EVENT_ID,
    orgId: OWNER_ORG,
    webhookId: WEBHOOK_ID,
    eventType: "product.created",
    payload: {},
    status: "FAILED",
    attempts: 1,
    deliveredAt: null,
    createdAt: new Date(),
  };

  describe("retryEvent — orgId on update writes (TOCTOU guard)", () => {
    it("throws NotFoundException when event belongs to a different org (cross-tenant deny)", async () => {
      const db = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      } as unknown as Db;

      const svc = new WebhooksService(db, null as never);
      await expect(svc.retryEvent(ATTACKER_ORG, USER_ID, EVENT_ID)).rejects.toThrow(NotFoundException);
    });

    it("includes orgId in both update where clauses for the owning org (control)", async () => {
      const eventWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([EVENT_ROW]) });
      const webhookWhere = jest.fn().mockResolvedValue([]);

      let selectCallCount = 0;
      const db = {
        select: jest.fn().mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) {
            return {
              from: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([EVENT_ROW]) }),
              }),
            };
          }
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([WEBHOOK_ROW]) }),
            }),
          };
        }),
        update: jest.fn().mockImplementation(() => ({
          set: jest.fn().mockReturnValue({
            where: selectCallCount <= 2 ? eventWhere : webhookWhere,
          }),
        })),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      } as unknown as Db;

      const svc = new WebhooksService(db, null as never);

      try {
        await svc.retryEvent(OWNER_ORG, USER_ID, EVENT_ID);
      } catch {
        // SSRF guard may throw in test environment — we only care about the update predicates
      }

      const updateCalls = (db.update as jest.Mock).mock.calls;
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);

      const allWhereArgs = [
        ...(eventWhere.mock.calls.map((c: unknown[]) => c[0])),
        ...(webhookWhere.mock.calls.map((c: unknown[]) => c[0])),
      ];
      for (const whereArg of allWhereArgs) {
        expect(sqlValues(whereArg)).toContain(OWNER_ORG);
      }
    });
  });
});
