import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPagesService } from "./kb-pages.service";
import { KbPageWriterService } from "./kb-page-writer.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbPagesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const PAGE_ID = 5;

  function makeUser(orgId: string) {
    return {
      orgId,
      userId: "user-1",
      isOrgOwner: false,
      principal: { kind: "human-session", membershipId: 1 },
    } as never;
  }

  const notifications = {} as never;
  const planLimits = {} as never;
  const auth = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: PAGE_ID, action: "edit", via: "admin" }),
    resolvePageAccess: jest.fn().mockResolvedValue({ outcome: "allowed", via: "admin" }),
  };

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
    return {
      db: {
        query: {
          kbPages: {
            findFirst: jest.fn().mockImplementation((opts: { where?: unknown } = {}) => {
              wheres.push(opts.where);
              return Promise.resolve(pageRow);
            }),
          },
          kbPageFavorites: {
            findFirst: jest.fn().mockResolvedValue(undefined),
          },
        },
        select: jest.fn().mockImplementation(() => ({
          from: jest.fn().mockReturnValue(makeJoinChain()),
        })),
        execute: jest.fn().mockResolvedValue([]),
      } as unknown as Db,
      wheres,
    };
  }

  it("throws NotFoundException for a page in another org (cross-tenant deny)", async () => {
    const { db, wheres } = makeDb(null);
    const svc = new KbPagesService(db, planLimits, auth as never, {} as never, {} as never, new KbPageWriterService({} as never));

    await expect(svc.get(makeUser(ATTACKER), PAGE_ID, false)).rejects.toThrow(NotFoundException);

    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns page for the owning org (same-tenant control)", async () => {
    const pageRow = {
      id: PAGE_ID,
      orgId: OWNER,
      parentPageId: null,
      title: "Test",
      content: null,
      contentText: null,
      publicToken: null,
      createdById: "user-1",
      createdByMembershipId: 1,
    };
    const { db } = makeDb(pageRow);
    const svc = new KbPagesService(db, planLimits, auth as never, {} as never, {} as never, new KbPageWriterService({} as never));

    const result = await svc.get(makeUser(OWNER), PAGE_ID, false);

    expect(result).toHaveProperty("id", PAGE_ID);
  });
});
