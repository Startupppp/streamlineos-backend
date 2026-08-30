import type { Db } from "../../db/drizzle.module";
import { SettingsCustomFieldsService } from "./settings-custom-fields.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("SettingsCustomFieldsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(wheres: unknown[]) {
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => {
            wheres.push(a);
            return Object.assign(Promise.resolve([]), {
              orderBy: jest.fn().mockResolvedValue([]),
            });
          }),
        }),
      })),
    } as unknown as Db;
  }

  it("scopes custom field list to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new SettingsCustomFieldsService(makeDb(wheres));

    await svc.listCustomFields(ATTACKER);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns custom fields for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new SettingsCustomFieldsService(makeDb(wheres));

    const result = await svc.listCustomFields(OWNER);

    expect(result).toBeDefined();
    expect(result).toHaveProperty("fields");
    expect(Array.isArray(result.fields)).toBe(true);
  });
});
