import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbCitationVisibilityService } from "./kb-citation-visibility.service";
import { KbAskService } from "./kb-ask.service";
import { ACCOUNT_ONLY_PRINCIPAL } from "../../../common/auth/principal";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("KbAskService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", isOrgOwner: false, principal: ACCOUNT_ONLY_PRINCIPAL } as never;
  }

  const aiGateway = {} as never;
  const events = { record: jest.fn().mockResolvedValue(undefined) } as never;
  const search = {} as never;
  const access = {} as never;
  const auth = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
  };

  function makeDb(hasContent: boolean) {
    const executeArgs: unknown[] = [];
    /**
     * `transaction` invokes its callback with the double itself. KB Ask now
     * carries `@NoTenantTransaction()`, so `runInTenantTransaction` really does
     * open a `withTenant` transaction rather than reusing an ambient one, and a
     * bare `jest.fn()` here would silently void every assertion inside it
     * (backend/CLAUDE.md 8). withTenant issues its own `SELECT set_config(...)`
     * through this same `execute`, which lands in `executeArgs` carrying the
     * requesting org — so the isolation assertions below still hold: the
     * attacker's org appears and the owner's never does.
     */
    const db: Record<string, unknown> = {
      execute: jest.fn().mockImplementation((sqlObj: unknown) => {
        executeArgs.push(sqlObj);
        return Promise.resolve(hasContent ? [{ one: 1 }] : []);
      }),
    };
    db.transaction = jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
    return { db: db as unknown as Db, executeArgs };
  }

  it("scopes indexed-content check to the requesting org (cross-tenant isolation)", async () => {
    const { db, executeArgs } = makeDb(false);
    const svc = new KbAskService(db, aiGateway, events, search, access, new KbCitationVisibilityService(db, access, search, auth as never));

    await svc.ask(makeUser(ATTACKER), { question: "test?" } as never);

    expect(executeArgs.length).toBeGreaterThan(0);
    const vals = executeArgs.flatMap(a => sqlValues(a));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns no-context answer for the owning org when no content exists (same-tenant control)", async () => {
    const { db } = makeDb(false);
    const svc = new KbAskService(db, aiGateway, events, search, access, new KbCitationVisibilityService(db, access, search, auth as never));

    const result = await svc.ask(makeUser(OWNER), { question: "test?" } as never);

    expect(result).toHaveProperty("hasContext", false);
  });
});

describe("KbAskService — page citation cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const PAGE_ID = 200;

  function makeUser(orgId: string) {
    return { orgId, userId: "user-1", isOrgOwner: false, principal: ACCOUNT_ONLY_PRINCIPAL } as never;
  }

  const auth = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: ATTACKER, pageId: PAGE_ID, action: "view", via: "space" }),
  };
  const access = {} as never;
  const events = { record: jest.fn().mockResolvedValue(undefined) } as never;

  const pageSearchMock = {
    retrieveTopArticles: jest.fn().mockResolvedValue([{
      kind: "page" as const,
      id: PAGE_ID,
      title: "Confidential page",
      spaceId: null,
      contentText: "sensitive content about the page",
      updatedAt: new Date("2024-01-01"),
    }]),
    retrieveTopSources: jest.fn().mockResolvedValue([]),
    retrieveDocumentPassages: jest.fn().mockResolvedValue([]),
    articleOwnerFilterFor: jest.fn().mockResolvedValue(sql`true`),
  };

  /**
   * Extends makeDb with a `select` mock so the page-visibility query in
   * `KbCitationVisibilityService.visiblePages` can be intercepted. The WHERE
   * clause that `visiblePages` builds includes `eq(kbPages.orgId, user.orgId)`;
   * capturing it lets us assert that the predicate binds the requesting user's
   * org and never reaches across to another tenant's rows.
   */
  function makeDbForPageTest(returnPageIds: number[]) {
    const executeArgs: unknown[] = [];
    const pageWheres: unknown[] = [];
    const db: Record<string, unknown> = {
      execute: jest.fn().mockImplementation((sqlObj: unknown) => {
        executeArgs.push(sqlObj);
        return Promise.resolve([{ one: 1 }]);
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((where: unknown) => {
            pageWheres.push(where);
            return Promise.resolve(returnPageIds.map((id) => ({ id })));
          }),
        }),
      }),
    };
    db.transaction = jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
    return { db: db as unknown as Db, executeArgs, pageWheres };
  }

  it("scopes page-visibility query to the requesting org — a cross-tenant page is never cited", async () => {
    const { db, pageWheres } = makeDbForPageTest([]);
    const svc = new KbAskService(
      db, {} as never, events, pageSearchMock as never, access,
      new KbCitationVisibilityService(db, access, pageSearchMock as never, auth as never),
    );

    await svc.ask(makeUser(ATTACKER), { question: "test?" } as never);

    expect(pageWheres.length).toBeGreaterThan(0);
    const allVals = pageWheres.flatMap((w) => sqlValues(w));
    expect(allVals).toContain(ATTACKER);
    expect(allVals).not.toContain(OWNER);
  });

  it("a page citation accessible to the asker IS included in citations (positive pair)", async () => {
    const gatewayOk = {
      invokeTextWithUsage: jest.fn().mockResolvedValue({
        ok: true as const,
        data: "Here is the answer about the page.",
        aiUsage: { model: "test", promptTokens: 1, completionTokens: 1, totalTokens: 2, credits: 0, costUsd: 0 },
      }),
    };
    const { db } = makeDbForPageTest([PAGE_ID]);
    const svc = new KbAskService(
      db, gatewayOk as never, events, pageSearchMock as never, access,
      new KbCitationVisibilityService(db, access, pageSearchMock as never, auth as never),
    );

    const result = await svc.ask(makeUser(ATTACKER), { question: "test?" } as never);

    expect(result.citations.some((c) => c.kind === "page" && c.pageId === PAGE_ID)).toBe(true);
  });
});
