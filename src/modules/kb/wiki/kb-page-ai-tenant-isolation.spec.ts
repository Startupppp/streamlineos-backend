import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageAiService } from "./kb-page-ai.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

const authMock = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "view", via: "admin" }),
};

describe("KbPageAiService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const PAGE_ID = 3;

  beforeEach(() => {
    authMock.visiblePagePredicate.mockClear();
    authMock.assertPageAccess.mockClear();
  });

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", isOrgOwner: false } as never;
  }

  const gateway = {
    invokeTextWithUsage: jest.fn().mockResolvedValue({ ok: true, data: "summary", aiUsage: undefined }),
  } as never;
  const audit = { log: jest.fn() } as never;

  function makeDb(pageRow: unknown) {
    const wheres: unknown[] = [];
    const makeJoinChain = (): Record<string, unknown> => {
      const chain: Record<string, unknown> = {
        where: jest.fn().mockImplementation((w: unknown) => {
          wheres.push(w);
          return Promise.resolve([]);
        }),
      };
      chain.innerJoin = jest.fn().mockReturnValue(chain);
      chain.leftJoin = jest.fn().mockReturnValue(chain);
      return chain;
    };
    /**
     * `summarize` reads through `loadPage`, which opens a SHORT tenant
     * transaction that COMMITS before `invokeTextWithUsage` — the fix for a
     * pooled connection held across the provider round trip. The double
     * therefore needs a `transaction` seam and the `execute` that `withTenant`'s
     * placement-fence probe issues; without them the isolation assertions below
     * never reach the query at all.
     */
    const surface = {
      query: {
        kbPages: {
          findFirst: jest.fn().mockImplementation((opts: { where?: unknown } = {}) => {
            wheres.push(opts.where);
            return Promise.resolve(pageRow);
          }),
        },
      },
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue(makeJoinChain()),
      })),
      execute: jest.fn().mockResolvedValue([{ placement_fence_held: 1 }]),
    };
    return {
      db: {
        ...surface,
        transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(surface),
      } as unknown as Db,
      wheres,
    };
  }

  it("throws NotFoundException for a page in another org (cross-tenant deny)", async () => {
    const { db, wheres } = makeDb(null);
    const svc = new KbPageAiService(db, gateway, audit, authMock as never);

    await expect(svc.summarize(makeUser(ATTACKER), PAGE_ID)).rejects.toThrow(NotFoundException);

    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns summary for a page in the owning org (same-tenant control)", async () => {
    const { db } = makeDb({ id: PAGE_ID, orgId: OWNER, title: "Test", contentText: "content" });
    const svc = new KbPageAiService(db, gateway, audit, authMock as never);

    const result = await svc.summarize(makeUser(OWNER), PAGE_ID);

    expect(result).toHaveProperty("text");
  });

  it("consults visiblePagePredicate with action 'view' so grant and space pages are included in AI context", async () => {
    const { db } = makeDb({ id: PAGE_ID, orgId: OWNER, title: "Test", contentText: "content" });
    const svc = new KbPageAiService(db, gateway, audit, authMock as never);

    await svc.summarize(makeUser(OWNER), PAGE_ID);

    expect(authMock.visiblePagePredicate).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: OWNER }),
      "view",
    );
  });
});
