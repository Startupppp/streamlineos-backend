import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbCitationVisibilityService } from "./kb-citation-visibility.service";
import { KbAskService } from "./kb-ask.service";
import { KbAskCitationService } from "./kb-ask-citations.service";
import { ACCOUNT_ONLY_PRINCIPAL } from "../../../common/auth/principal";
import { NO_LINKED_DOCUMENTS } from "../../../test/kb-linked-document-ask-source.spec-fixtures";

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
  const search = { aclCacheOutcome: jest.fn().mockResolvedValue("bypass") } as never;
  const access = {} as never;
  const auth = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    resolveStanding: jest.fn().mockImplementation((user: { orgId: string; userId: string }) => Promise.resolve({ orgId: user.orgId, userId: user.userId, membershipId: null, roleSlugs: [], isOrgOwner: false, isKbAdmin: false, accessibleSpaceIds: [], accessibleProjectIds: [], permissionsVersion: 1 })),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
  };

  function makeDb(hasContent: boolean) {
    const executeArgs: unknown[] = [];
    const insertedRows: Record<string, unknown>[] = [];
    const db: Record<string, unknown> = {
      execute: jest.fn().mockImplementation((sqlObj: unknown) => {
        executeArgs.push(sqlObj);
        return Promise.resolve(hasContent ? [{ one: 1 }] : []);
      }),
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
          insertedRows.push(row);
          return Promise.resolve([]);
        }),
      })),
    };
    db.transaction = jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
    return { db: db as unknown as Db, executeArgs, insertedRows };
  }

  it("scopes indexed-content check to the requesting org (cross-tenant isolation)", async () => {
    const { db, executeArgs } = makeDb(false);
    const retrieval = { retrieve: jest.fn().mockResolvedValue({ documents: [], sources: [], passages: [], degraded: { kind: "none" as const }, strategy: { kind: "exact" as const } }) };
    const svc = new KbAskService(db, aiGateway, events, search, new KbAskCitationService(db, new KbCitationVisibilityService(db, search, auth as never), NO_LINKED_DOCUMENTS) as never, NO_LINKED_DOCUMENTS, null, retrieval as never);

    await svc.ask(makeUser(ATTACKER), { question: "test?" } as never);

    expect(executeArgs.length).toBeGreaterThan(0);
    const vals = executeArgs.flatMap(a => sqlValues(a));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns no-context answer for the owning org when no content exists (same-tenant control)", async () => {
    const { db } = makeDb(false);
    const retrieval = { retrieve: jest.fn().mockResolvedValue({ documents: [], sources: [], passages: [], degraded: { kind: "none" as const }, strategy: { kind: "exact" as const } }) };
    const svc = new KbAskService(db, aiGateway, events, search, new KbAskCitationService(db, new KbCitationVisibilityService(db, search, auth as never), NO_LINKED_DOCUMENTS) as never, NO_LINKED_DOCUMENTS, null, retrieval as never);

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
    resolveQueryEmbedding: jest.fn().mockResolvedValue({ vectorLiteral: null }),
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
    aclCacheOutcome: jest.fn().mockResolvedValue("bypass"),
  };

  function makeDbForPageTest(returnPageIds: number[]) {
    const executeArgs: unknown[] = [];
    const pageWheres: unknown[] = [];
    const insertedRows: Record<string, unknown>[] = [];
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
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
          insertedRows.push(row);
          return Promise.resolve([]);
        }),
      })),
    };
    db.transaction = jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
    return { db: db as unknown as Db, executeArgs, pageWheres, insertedRows };
  }

  it("scopes page-visibility query to the requesting org — a cross-tenant page is never cited", async () => {
    const { db, pageWheres } = makeDbForPageTest([]);
    const retrieval = { retrieve: jest.fn().mockResolvedValue({ documents: [{ kind: "page" as const, id: PAGE_ID, title: "Confidential page", spaceId: null, contentText: "sensitive content about the page", updatedAt: new Date("2024-01-01") }], sources: [], passages: [], degraded: { kind: "none" as const }, strategy: { kind: "exact" as const } }) };
    const svc = new KbAskService(
      db, {} as never, events, pageSearchMock as never,
      new KbAskCitationService(db, new KbCitationVisibilityService(db, pageSearchMock as never, auth as never), NO_LINKED_DOCUMENTS) as never,
      NO_LINKED_DOCUMENTS, null, retrieval as never,
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
    const { db, insertedRows } = makeDbForPageTest([PAGE_ID]);
    const retrieval = { retrieve: jest.fn().mockResolvedValue({ documents: [{ kind: "page" as const, id: PAGE_ID, title: "Confidential page", spaceId: null, contentText: "sensitive content about the page", updatedAt: new Date("2024-01-01") }], sources: [], passages: [], degraded: { kind: "none" as const }, strategy: { kind: "exact" as const } }) };
    const svc = new KbAskService(
      db, gatewayOk as never, events, pageSearchMock as never,
      new KbAskCitationService(db, new KbCitationVisibilityService(db, pageSearchMock as never, auth as never), NO_LINKED_DOCUMENTS) as never,
      NO_LINKED_DOCUMENTS, null, retrieval as never,
    );

    const result = await svc.ask(makeUser(ATTACKER), { question: "test?" } as never);

    expect(result.citations.some((c) => c.kind === "page" && c.pageId === PAGE_ID)).toBe(true);
    expect(insertedRows.some((r) => r["resultState"] === "answered")).toBe(true);
  });
});
