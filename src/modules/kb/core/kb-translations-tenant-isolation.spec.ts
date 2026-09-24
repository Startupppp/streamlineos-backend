import { PgDialect } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbTranslationsService } from "./kb-translations.service";

const dialect = new PgDialect();

function render(condition: unknown): string {
  if (!(condition instanceof SQL))
    throw new Error("the query ran with no SQL condition");
  return dialect.sqlToQuery(condition).sql;
}

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
        kbPages: {
          findFirst: jest.fn().mockImplementation(({ where } = {}) => {
            wheres.push(where);
            return Promise.resolve(articleRow);
          }),
        },
        kbPageTranslations: {
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

  it("resolves the id against support articles only, so a wiki page id cannot open the article route", async () => {
    const wheres: unknown[] = [];
    const svc = new KbTranslationsService(makeDb(wheres, { id: 1, orgId: OWNER }));

    await svc.list(OWNER, 1);

    const lookup = render(wheres[0]);
    expect(lookup).toContain("content_type");
    expect(lookup).toContain("deleted_at");
  });

  it("bites: the translation row query itself carries neither filter, because it is keyed by the page the lookup already vetted", async () => {
    const wheres: unknown[] = [];
    const svc = new KbTranslationsService(makeDb(wheres, { id: 1, orgId: OWNER }));

    await svc.list(OWNER, 1);

    const rows = render(wheres[1]);
    expect(rows).toContain("kb_page_translations");
    expect(rows).not.toContain("content_type");
  });

  it("a missing support article is a 404 on every verb that takes a locale", async () => {
    const svc = new KbTranslationsService(makeDb([], undefined));

    await expect(svc.get(OWNER, 1, "fr")).rejects.toThrow("Article not found");
    await expect(svc.remove(OWNER, 1, "fr")).rejects.toThrow("Article not found");
  });
});
