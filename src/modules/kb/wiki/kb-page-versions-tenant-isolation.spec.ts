import { NotFoundException } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { KbPageVersionsService } from "./kb-page-versions.service";

describe("KbPageVersionsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const PAGE_ID = 42;

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", role: "MEMBER", isOrgOwner: false } as never;
  }

  function makeAuthMock(opts: { throws?: unknown } = {}) {
    return {
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
      assertPageAccess: opts.throws
        ? jest.fn().mockRejectedValue(opts.throws)
        : jest.fn().mockResolvedValue({ orgId: OWNER, pageId: PAGE_ID, action: "view", via: "admin" }),
    };
  }

  function makeDb() {
    const wheres: unknown[] = [];
    const leftJoinChain = {
      where: jest.fn().mockImplementation((clause: unknown) => {
        wheres.push(clause);
        return Object.assign(Promise.resolve([]), {
          orderBy: jest.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              limit: jest.fn().mockResolvedValue([]),
            }),
          ),
        });
      }),
    };
    return {
      wheres,
      db: {
        query: {
          kbPages: {
            findFirst: jest.fn().mockResolvedValue(null),
          },
        },
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockImplementation(() => ({
            leftJoin: jest.fn().mockReturnValue(leftJoinChain),
          })),
        })),
      } as unknown as Db,
    };
  }

  it("throws NotFoundException for a page belonging to another org (cross-tenant deny)", async () => {
    const { db } = makeDb();
    const authMock = makeAuthMock({ throws: new NotFoundException("Page not found") });
    const svc = new KbPageVersionsService(db, authMock as never);

    await expect(svc.listVersions(makeUser(ATTACKER), PAGE_ID)).rejects.toThrow(NotFoundException);

    expect(authMock.assertPageAccess).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ATTACKER }),
      PAGE_ID,
      "view",
    );
  });

  it("returns versions for a page in the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const authMock = makeAuthMock();
    const svc = new KbPageVersionsService(db, authMock as never);

    const result = await svc.listVersions(makeUser(OWNER), PAGE_ID);

    expect(authMock.assertPageAccess).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: OWNER }),
      PAGE_ID,
      "view",
    );
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("still binds the caller's org into the version query itself, so isolation does not rest on the seam alone", async () => {
    const { db, wheres } = makeDb();
    const svc = new KbPageVersionsService(db, makeAuthMock() as never);

    await svc.listVersions(makeUser(OWNER), PAGE_ID);

    expect(wheres).toHaveLength(1);
    const rendered = new PgDialect().sqlToQuery(wheres[0] as SQL);
    expect(rendered.params).toContain(OWNER);
    expect(rendered.params).not.toContain(ATTACKER);
  });
});
