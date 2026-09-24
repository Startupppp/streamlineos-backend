import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageCommentsService } from "./kb-page-comments.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbPageCommentsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const PAGE_ID = 9;

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", isOrgOwner: false } as never;
  }

  const dispatch = { dispatch: jest.fn() } as never;
  const access = { holds: jest.fn().mockResolvedValue(false) } as never;
  const authMock = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: OWNER, pageId: PAGE_ID, action: "view", via: "admin" }),
  };

  function makeDb(pageRow: unknown) {
    const wheres: unknown[] = [];
    const makeJoinChain = (): Record<string, unknown> => {
      const chain: Record<string, unknown> = {
        where: jest.fn().mockImplementation((w: unknown) => {
          wheres.push(w);
          return Object.assign(Promise.resolve([]), {
            orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          });
        }),
      };
      chain.innerJoin = jest.fn().mockReturnValue(chain);
      chain.leftJoin = jest.fn().mockReturnValue(chain);
      return chain;
    };
    return {
      db: {
        query: {
          kbPages: {
            findFirst: jest.fn().mockImplementation((opts: { where?: unknown } = {}) => {
              wheres.push(opts.where);
              return Promise.resolve(pageRow);
            }),
          },
        },
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockImplementation(() => ({
            ...makeJoinChain(),
          })),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  it("throws NotFoundException for a page in another org (cross-tenant deny)", async () => {
    const { db, wheres } = makeDb(null);
    const svc = new KbPageCommentsService(db, dispatch, access, authMock as never);

    await expect(svc.list(makeUser(ATTACKER), PAGE_ID)).rejects.toThrow(NotFoundException);

    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns comments for a page in the owning org (same-tenant control)", async () => {
    const { db } = makeDb({ id: PAGE_ID, orgId: OWNER });
    const svc = new KbPageCommentsService(db, dispatch, access, authMock as never);

    const result = await svc.list(makeUser(OWNER), PAGE_ID);

    expect(Array.isArray(result)).toBe(true);
  });
});
