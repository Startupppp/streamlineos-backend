import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbPageVersionsService } from "./kb-page-versions.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbPageVersionsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const PAGE_ID = 42;

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", role: "MEMBER", isOrgOwner: false } as never;
  }

  function makeDb(pageRow: unknown) {
    const wheres: unknown[] = [];
    const innerJoinChain: Record<string, unknown> = {
      where: jest.fn().mockImplementation((w: unknown) => {
        wheres.push(w);
        return Promise.resolve([]);
      }),
    };
    innerJoinChain.innerJoin = jest.fn().mockReturnValue(innerJoinChain);
    const leftJoinChain = {
      where: jest.fn().mockImplementation((w: unknown) => {
        wheres.push(w);
        const sorted = Object.assign(Promise.resolve(pageRow ? [{ id: 1 }] : []), {
          orderBy: jest.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              limit: jest.fn().mockResolvedValue([]),
            }),
          ),
        });
        return sorted;
      }),
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
            innerJoin: jest.fn().mockReturnValue(innerJoinChain),
            leftJoin: jest.fn().mockReturnValue(leftJoinChain),
          })),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  it("throws NotFoundException for a page belonging to another org (cross-tenant deny)", async () => {
    const { db, wheres } = makeDb(null);
    const svc = new KbPageVersionsService(db);

    await expect(svc.listVersions(makeUser(ATTACKER), PAGE_ID)).rejects.toThrow(NotFoundException);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns versions for a page in the owning org (same-tenant control)", async () => {
    const { db } = makeDb({ id: PAGE_ID, orgId: OWNER });
    const svc = new KbPageVersionsService(db);

    const result = await svc.listVersions(makeUser(OWNER), PAGE_ID);

    expect(Array.isArray(result)).toBe(true);
  });
});
