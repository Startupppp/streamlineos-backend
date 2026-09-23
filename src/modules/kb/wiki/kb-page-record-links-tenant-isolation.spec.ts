import { NotFoundException } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { KbPageRecordLinksService } from "./kb-page-record-links.service";

describe("KbPageRecordLinksService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const PAGE_ID = 7;

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", isOrgOwner: false } as never;
  }

  function makeDb() {
    const wheres: unknown[] = [];
    const capture = jest.fn().mockImplementation((clause: unknown) => {
      wheres.push(clause);
      return Promise.resolve([]);
    });
    const makeJoinChain = (): Record<string, unknown> => {
      const chain: Record<string, unknown> = { where: capture };
      chain.innerJoin = jest.fn().mockReturnValue(chain);
      chain.leftJoin = jest.fn().mockReturnValue(chain);
      return chain;
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
            ...makeJoinChain(),
            where: capture,
          })),
        })),
      } as unknown as Db,
    };
  }

  it("throws NotFoundException for a page in another org (cross-tenant deny)", async () => {
    const { db } = makeDb();
    const authMock = {
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
      assertPageAccess: jest.fn().mockRejectedValue(new NotFoundException("Page not found")),
    };
    const svc = new KbPageRecordLinksService(db, authMock as never);

    await expect(svc.list(makeUser(ATTACKER), PAGE_ID)).rejects.toThrow(NotFoundException);

    expect(authMock.assertPageAccess).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ATTACKER }),
      PAGE_ID,
      "view",
    );
  });

  it("returns links for a page in the owning org (same-tenant control)", async () => {
    const { db } = makeDb();
    const authMock = {
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
      assertPageAccess: jest.fn().mockResolvedValue({ orgId: OWNER, pageId: PAGE_ID, action: "view", via: "admin" }),
    };
    const svc = new KbPageRecordLinksService(db, authMock as never);

    const result = await svc.list(makeUser(OWNER), PAGE_ID);

    expect(authMock.assertPageAccess).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: OWNER }),
      PAGE_ID,
      "view",
    );
    expect(Array.isArray(result)).toBe(true);
  });

  it("still binds the caller's org into the record-link query itself, so isolation does not rest on the seam alone", async () => {
    const { db, wheres } = makeDb();
    const authMock = {
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
      assertPageAccess: jest
        .fn()
        .mockResolvedValue({ orgId: OWNER, pageId: PAGE_ID, action: "view", via: "admin" }),
    };

    await new KbPageRecordLinksService(db, authMock as never).list(makeUser(OWNER), PAGE_ID);

    expect(wheres.length).toBeGreaterThan(0);
    const params = wheres.flatMap((w) => new PgDialect().sqlToQuery(w as SQL).params);
    expect(params).toContain(OWNER);
    expect(params).not.toContain(ATTACKER);
  });
});
