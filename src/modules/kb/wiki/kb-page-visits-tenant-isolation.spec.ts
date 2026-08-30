import { ForbiddenException } from "@nestjs/common";
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

describe("KbPageVisitsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", isOrgOwner: false } as never;
  }

  function makeDb(membershipRow: unknown) {
    const wheres: unknown[] = [];
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
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockImplementation((w: unknown) => {
                wheres.push(w);
                return Promise.resolve([]);
              }),
            }),
            where: jest.fn().mockImplementation((w: unknown) => {
              wheres.push(w);
              return Object.assign(Promise.resolve([]), {
                orderBy: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([]) })),
              });
            }),
          }),
        })),
      } as unknown as Db,
      wheres,
    };
  }

  it("throws ForbiddenException when membership not found for org (cross-tenant deny)", async () => {
    const { db, wheres } = makeDb(null);
    const svc = new KbPageVisitsService(db);

    await expect(svc.getRecent(makeUser(ATTACKER))).rejects.toThrow(ForbiddenException);

    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns page list for owning org member (same-tenant control)", async () => {
    const { db } = makeDb({ id: 1 });
    const svc = new KbPageVisitsService(db);

    const result = await svc.getRecent(makeUser(OWNER));

    expect(Array.isArray(result)).toBe(true);
  });
});
