import type { Db } from "../../../db/drizzle.module";
import { KbSourcesService } from "./kb-sources.service";
import { kbSourcesListQuerySchema } from "./dto/kb-sources.schemas";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbSourcesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  /* The list is a keyset page now; the tenant predicate this file guards is unchanged. */
  const FIRST_PAGE = kbSourcesListQuerySchema.parse({});

  const storage = {} as never;
  const indexing = {} as never;
  const config = {} as never;

  function makeDb() {
    const wheres: unknown[] = [];
    return {
      db: {
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((w: unknown) => {
              wheres.push(w);
              return Object.assign(Promise.resolve([]), {
                orderBy: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([]) })),
                limit: jest.fn().mockResolvedValue([]),
              });
            }),
          }),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  it("scopes source list to the requesting org (cross-tenant isolation)", async () => {
    const { db, wheres } = makeDb();
    const svc = new KbSourcesService(db, storage, indexing, config);

    await svc.list(ATTACKER, FIRST_PAGE);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns sources for the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const svc = new KbSourcesService(db, storage, indexing, config);

    const page = await svc.list(OWNER, FIRST_PAGE);

    expect(Array.isArray(page.data)).toBe(true);
  });
});
