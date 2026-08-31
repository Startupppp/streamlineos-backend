// Covers: src/modules/notifications/notification-template-renderer.service.ts
import type { Db } from "../../db/drizzle.module";
import { NotificationTemplateRenderer } from "./notification-template-renderer.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("NotificationTemplateRenderer — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(): { db: Db; wheres: unknown[] } {
    const wheres: unknown[] = [];
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => {
            wheres.push(a);
            return Promise.resolve([]);
          }),
        }),
      })),
    } as unknown as Db;
    return { db, wheres };
  }

  it("scopes template loading to the requesting org (tenant isolation)", async () => {
    const { db, wheres } = makeDb();
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new NotificationTemplateRenderer(db, cache);
    const def = { key: "test.event", templateKey: "test", label: "Test", channel: "IN_APP", defaultEnabled: true };

    await svc.loadTemplates(ATTACKER, def as never, {}, "en");

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns template map for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const cache = { cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new NotificationTemplateRenderer(db, cache);
    const def = { key: "test.event", templateKey: "test", label: "Test", channel: "IN_APP", defaultEnabled: true };

    const result = await svc.loadTemplates(OWNER, def as never, {}, "en");

    expect(result).toBeDefined();
    expect(result instanceof Map).toBe(true);
  });
});
