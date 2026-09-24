import { ForbiddenException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageVisitsService } from "./kb-page-visits.service";

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

describe("KbPageVisitsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  beforeEach(() => {
    authMock.visiblePagePredicate.mockClear();
    authMock.assertPageAccess.mockClear();
  });

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", isOrgOwner: false } as never;
  }

  function makeDb(membershipRow: unknown) {
    const wheres: unknown[] = [];
    const makeJoinChain = (): Record<string, unknown> => {
      const chain: Record<string, unknown> = {
        where: jest.fn().mockImplementation((w: unknown) => {
          wheres.push(w);
          return Promise.resolve([]);
        }),
        orderBy: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([]) })),
      };
      chain.innerJoin = jest.fn().mockReturnValue(chain);
      chain.leftJoin = jest.fn().mockReturnValue(chain);
      return chain;
    };
    return {
      db: {
        query: {
          organizationMembers: {
            findFirst: jest.fn().mockImplementation((opts: { where?: unknown } = {}) => {
              wheres.push(opts.where);
              return Promise.resolve(membershipRow);
            }),
          },
        },
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockImplementation(() => ({
            ...makeJoinChain(),
            where: jest.fn().mockImplementation((w: unknown) => {
              wheres.push(w);
              return Object.assign(Promise.resolve([]), {
                orderBy: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([]) })),
              });
            }),
          })),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  it("throws ForbiddenException when membership not found for org (cross-tenant deny)", async () => {
    const { db, wheres } = makeDb(null);
    const svc = new KbPageVisitsService(db, authMock as never);

    await expect(svc.getRecent(makeUser(ATTACKER))).rejects.toThrow(ForbiddenException);

    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns page list for owning org member (same-tenant control)", async () => {
    const { db } = makeDb({ id: 1 });
    const svc = new KbPageVisitsService(db, authMock as never);

    const result = await svc.getRecent(makeUser(OWNER));

    expect(Array.isArray(result)).toBe(true);
  });

  it("consults visiblePagePredicate with action 'view' so shared and space pages are not silently omitted from recent list", async () => {
    const { db } = makeDb({ id: 1 });
    const svc = new KbPageVisitsService(db, authMock as never);

    await svc.getRecent(makeUser(OWNER));

    expect(authMock.visiblePagePredicate).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: OWNER }),
      "view",
    );
  });
});
