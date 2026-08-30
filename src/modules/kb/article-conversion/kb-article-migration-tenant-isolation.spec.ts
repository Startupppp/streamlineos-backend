jest.mock("../../../common/tenant/with-tenant", () => ({
  withTenant: jest.fn().mockImplementation((_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => fn(_db)),
}));
jest.mock("../../../common/tenant/tenant-context", () => ({
  runWithTenantContext: jest.fn().mockImplementation((_ctx: unknown, fn: () => unknown) => fn()),
}));

import type { Db } from "../../../db/drizzle.module";
import { KbArticleMigrationService } from "./kb-article-migration.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbArticleMigrationService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb() {
    const wheres: unknown[] = [];
    return {
      db: {
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((w: unknown) => {
              wheres.push(w);
              return Object.assign(Promise.resolve([]), {
                groupBy: jest.fn().mockResolvedValue([]),
              });
            }),
          }),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  it("scopes article migration preview to the requesting org (cross-tenant isolation)", async () => {
    const { db, wheres } = makeDb();
    const svc = new KbArticleMigrationService(db);

    await svc.preview(ATTACKER);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns preview data for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const svc = new KbArticleMigrationService(db);

    const result = await svc.preview(OWNER);

    expect(result).toHaveProperty("total");
  });
});
