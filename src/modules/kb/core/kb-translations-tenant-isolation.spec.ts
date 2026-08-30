import type { Db } from "../../../db/drizzle.module";
import { KbTranslationsService } from "./kb-translations.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbTranslationsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(wheres: unknown[], articleRow: unknown) {
    return {
      query: {
        kbArticles: {
          findFirst: jest.fn().mockImplementation(({ where } = {}) => {
            wheres.push(where);
            return Promise.resolve(articleRow);
          }),
        },
        kbArticleTranslations: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
      },
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

  it("scopes translation queries to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new KbTranslationsService(makeDb(wheres, { id: 1, orgId: ATTACKER }));

    await svc.list(ATTACKER, 1);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns translations for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new KbTranslationsService(makeDb(wheres, { id: 1, orgId: OWNER }));

    const result = await svc.list(OWNER, 1);

    expect(Array.isArray(result)).toBe(true);
  });
});
