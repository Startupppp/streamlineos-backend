import type { Db } from "../../db/drizzle.module";
import { NotificationEventRegistryService } from "./notification-event-registry.service";

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

describe("NotificationEventRegistryService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeDb(): { db: Db; allWhereArgs: unknown[] } {
    const allWhereArgs: unknown[] = [];
    const findMany = jest.fn().mockImplementation(({ where } = {}) => {
      if (where) allWhereArgs.push(where);
      return Promise.resolve([]);
    });
    const db = {
      query: { notificationEvents: { findMany } },
    } as unknown as Db;
    return { db, allWhereArgs };
  }

  it("scopes org event list to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb();
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new NotificationEventRegistryService(db, cache);

    await svc.listForOrg(ATTACKER_ORG);

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
    expect(allVals).not.toContain(OWNER_ORG);
  });

  it("returns event definitions for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new NotificationEventRegistryService(db, cache);

    const result = await svc.listForOrg(OWNER_ORG);

    expect(result).toBeInstanceOf(Array);
  });
});
