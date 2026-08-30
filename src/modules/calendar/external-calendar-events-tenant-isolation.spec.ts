jest.mock("../integrations/core/composio.gateway", () => ({
  ComposioGateway: class {},
  ComposioToolError: class extends Error { isAuthError = false; },
}));

import type { Db } from "../../db/drizzle.module";
import { ExternalCalendarEventsService } from "./external-calendar-events.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("ExternalCalendarEventsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(wheres: unknown[], connectionsRows: unknown[] = []) {
    let callCount = 0;
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => {
            wheres.push(a);
            callCount += 1;
            return Promise.resolve(callCount === 1 ? connectionsRows : []);
          }),
        }),
      })),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ catch: jest.fn() }) }),
      }),
    } as unknown as Db;
  }

  function makeCache() {
    return {
      cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()),
    } as never;
  }

  function makeGateway(configured = true) {
    return {
      isConfigured: jest.fn().mockReturnValue(configured),
      executeTool: jest.fn().mockResolvedValue({ items: [] }),
    } as never;
  }

  it("scopes external event queries to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new ExternalCalendarEventsService(makeDb(wheres), makeCache(), makeGateway());

    await svc.getExternalEvents(ATTACKER, "user-1", "2024-01-01", "2024-01-31");

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns external events for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new ExternalCalendarEventsService(makeDb(wheres), makeCache(), makeGateway());

    const result = await svc.getExternalEvents(OWNER, "user-1", "2024-01-01", "2024-01-31");

    expect(result).toBeDefined();
    expect(result).toHaveProperty("events");
    expect(result).toHaveProperty("errors");
  });

  it("returns empty when gateway is not configured (short-circuit control)", async () => {
    const wheres: unknown[] = [];
    const svc = new ExternalCalendarEventsService(makeDb(wheres), makeCache(), makeGateway(false));

    const result = await svc.getExternalEvents(OWNER, "user-1", "2024-01-01", "2024-01-31");

    expect(result.events).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
