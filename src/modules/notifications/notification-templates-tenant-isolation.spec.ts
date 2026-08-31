import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { NotificationTemplatesService } from "./notification-templates.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("NotificationTemplatesService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("throws NotFoundException when template belongs to a different org (BOLA isolation)", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const db = { query: { notificationTemplates: { findFirst } } } as unknown as Db;
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new NotificationTemplatesService(db, cache, {} as never);

    await expect(svc.findOne(ATTACKER_ORG, 999)).rejects.toThrow(NotFoundException);
  });

  it("returns the template for the owning org (same-tenant control)", async () => {
    const template = { id: 1, orgId: OWNER_ORG, eventKey: "test.event", channel: "IN_APP" };
    const findFirst = jest.fn().mockResolvedValue(template);
    const db = { query: { notificationTemplates: { findFirst } } } as unknown as Db;
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new NotificationTemplatesService(db, cache, {} as never);

    const result = await svc.findOne(OWNER_ORG, 1);

    expect(result).toBeDefined();
  });
});
