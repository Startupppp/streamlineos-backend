import type { Db } from "../../db/drizzle.module";
import { SettingsAutomationsService } from "./settings-automations.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeChain(rows: unknown[] = []): object {
  return Object.assign(Promise.resolve(rows), {
    orderBy: jest.fn().mockImplementation(() => Object.assign(Promise.resolve(rows), {
      limit: jest.fn().mockImplementation(() => Object.assign(Promise.resolve(rows), {
        offset: jest.fn().mockResolvedValue(rows),
      })),
    })),
    where: jest.fn().mockImplementation(() => makeChain(rows)),
  });
}

describe("SettingsAutomationsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(wheres: unknown[]) {
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => {
            wheres.push(a);
            return makeChain([{ total: 0 }]);
          }),
        }),
      })),
    } as unknown as Db;
  }

  const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never;

  it("scopes automation list to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new SettingsAutomationsService(makeDb(wheres), planLimits);

    await svc.listAutomations(ATTACKER, { page: 1, limit: 20 });

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns automations for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new SettingsAutomationsService(makeDb(wheres), planLimits);

    const result = await svc.listAutomations(OWNER, { page: 1, limit: 20 });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("pagination");
  });
});
