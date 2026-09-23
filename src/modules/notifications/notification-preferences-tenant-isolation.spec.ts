import type { Db } from "../../db/drizzle.module";
import { NotificationPreferencesService } from "./notification-preferences.service";
import type { NotificationConsentService } from "./notification-consent.service";

function consentsStub(): NotificationConsentService {
  return {
    withdrawChannels: jest.fn().mockResolvedValue(0),
  } as unknown as NotificationConsentService;
}

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

describe("NotificationPreferencesService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeDb(): { db: Db; allWhereArgs: unknown[] } {
    const allWhereArgs: unknown[] = [];
    const findFirst = jest.fn().mockImplementation(({ where } = {}) => {
      if (where) allWhereArgs.push(where);
      return Promise.resolve(undefined);
    });
    const db = {
      query: {
        notificationPreferences: { findFirst },
        notificationPolicyDefaults: { findFirst },
      },
    } as unknown as Db;
    return { db, allWhereArgs };
  }

  it("scopes preference lookup to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb();
    const registry = {} as never;
    const svc = new NotificationPreferencesService(db, registry, consentsStub(), { loadOrgAvailability: jest.fn().mockResolvedValue(new Set()) } as unknown as ConstructorParameters<typeof NotificationPreferencesService>[3]);

    await svc.get(ATTACKER_ORG, "user-1");

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns preferences for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const registry = {} as never;
    const svc = new NotificationPreferencesService(db, registry, consentsStub(), { loadOrgAvailability: jest.fn().mockResolvedValue(new Set()) } as unknown as ConstructorParameters<typeof NotificationPreferencesService>[3]);

    const result = await svc.get(OWNER_ORG, "user-1");

    expect(result).toBeDefined();
    expect(result.orgId).toBe(OWNER_ORG);
  });
});
