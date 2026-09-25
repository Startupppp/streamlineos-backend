import { KbAskService } from "./kb-ask.service";
import { ACCOUNT_ONLY_PRINCIPAL } from "../../../common/auth/principal";
import { NO_LINKED_DOCUMENTS } from "../../../test/kb-linked-document-ask-source.spec-fixtures";
import type { Db } from "../../../db/drizzle.module";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

describe("KbAiInteractions — cross-tenant write isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeUser(orgId: string) {
    return {
      orgId,
      userId: "user-1",
      isOrgOwner: false,
      principal: ACCOUNT_ONLY_PRINCIPAL,
    } as never;
  }

  function buildDb() {
    const allInsertValues: unknown[] = [];
    const db: Record<string, unknown> = {
      execute: jest.fn().mockResolvedValue([{ one: 1 }]),
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((row: unknown) => {
          allInsertValues.push(row);
          return Promise.resolve([]);
        }),
      })),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ id: 1 }]),
        }),
      }),
    };
    db.transaction = jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
    return { db: db as unknown as Db, allInsertValues };
  }

  it("interaction row is written with the requesting org — never bleeds into another tenant", async () => {
    const { db, allInsertValues } = buildDb();
    const events = { record: jest.fn().mockResolvedValue(undefined) };
    const search = {
      retrieveTopArticles: jest.fn().mockResolvedValue([{
        kind: "article" as const, id: 1, title: "t",
        slug: "t", spaceId: 1, contentText: "text",
        updatedAt: new Date(),
      }]),
      retrieveTopSources: jest.fn().mockResolvedValue([]),
      retrieveDocumentPassages: jest.fn().mockResolvedValue([]),
    };
    const citationVisibility = {
      visibleArticles: jest.fn().mockResolvedValue(new Set([1])),
      visiblePages: jest.fn().mockResolvedValue(new Set()),
      visibleSources: jest.fn().mockResolvedValue(new Set()),
    };
    const access = {
      getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
      getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
      getPrincipalIds: jest.fn().mockResolvedValue({ userId: "user-1", roleSlugs: [] }),
      isAdmin: jest.fn().mockResolvedValue(false),
    };
    const auth = {
      visiblePagePredicate: jest.fn().mockResolvedValue({ queryChunks: [{ value: "true" }] }),
      assertPageAccess: jest.fn().mockResolvedValue({}),
    };
    const KbCitationVisibilityService = (await import("./kb-citation-visibility.service")).KbCitationVisibilityService;
    const gateway = {
      invokeTextWithUsage: jest.fn().mockResolvedValue({
        ok: true, data: "answer", correlationId: "gw-1",
        aiUsage: { model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2, credits: 0, costUsd: 0 },
      }),
    };

    const svc = new KbAskService(
      db, gateway as never, events as never, search as never,
      new KbCitationVisibilityService(db, access as never, search as never, auth as never),
      NO_LINKED_DOCUMENTS,
    );

    await svc.ask(makeUser(ATTACKER), { question: "test?" } as never);

    const interactionRows = allInsertValues.filter(
      (r): r is Record<string, unknown> =>
        typeof r === "object" && r !== null && "correlationId" in r,
    );
    expect(interactionRows.length).toBeGreaterThan(0);

    for (const row of interactionRows) {
      expect(row.orgId).toBe(ATTACKER);
      expect(row.orgId).not.toBe(OWNER);
    }
  });

  it("interaction rows written for two separate tenants carry different orgIds (positive pair)", async () => {
    async function runAsk(orgId: string) {
      const { db, allInsertValues } = buildDb();
      const events = { record: jest.fn().mockResolvedValue(undefined) };
      const search = {
        retrieveTopArticles: jest.fn().mockResolvedValue([{
          kind: "article" as const, id: 5, title: "doc",
          slug: "doc", spaceId: 1, contentText: "text",
          updatedAt: new Date(),
        }]),
        retrieveTopSources: jest.fn().mockResolvedValue([]),
        retrieveDocumentPassages: jest.fn().mockResolvedValue([]),
      };
      const citationVisibility = {
        visibleArticles: jest.fn().mockResolvedValue(new Set([5])),
        visiblePages: jest.fn().mockResolvedValue(new Set()),
        visibleSources: jest.fn().mockResolvedValue(new Set()),
      };
      const access = {
        getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
        getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
        getPrincipalIds: jest.fn().mockResolvedValue({ userId: "u", roleSlugs: [] }),
        isAdmin: jest.fn().mockResolvedValue(false),
      };
      const auth = {
        visiblePagePredicate: jest.fn().mockResolvedValue({ queryChunks: [{ value: "true" }] }),
        assertPageAccess: jest.fn().mockResolvedValue({}),
      };
      const KbCitationVisibilityService = (await import("./kb-citation-visibility.service")).KbCitationVisibilityService;
      const gateway = {
        invokeTextWithUsage: jest.fn().mockResolvedValue({
          ok: true, data: "ans", correlationId: `gw-${orgId}`,
          aiUsage: { model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2, credits: 0, costUsd: 0 },
        }),
      };
      const svc = new KbAskService(
        db, gateway as never, events as never, search as never,
        new KbCitationVisibilityService(db, access as never, search as never, auth as never),
        NO_LINKED_DOCUMENTS,
      );
      await svc.ask(makeUser(orgId), { question: "?" } as never);
      return allInsertValues;
    }

    const attackerRows = await runAsk(ATTACKER);
    const ownerRows = await runAsk(OWNER);

    const attackerInteraction = attackerRows.find(
      (r): r is Record<string, unknown> => typeof r === "object" && r !== null && "correlationId" in r,
    );
    const ownerInteraction = ownerRows.find(
      (r): r is Record<string, unknown> => typeof r === "object" && r !== null && "correlationId" in r,
    );

    expect(attackerInteraction?.orgId).toBe(ATTACKER);
    expect(ownerInteraction?.orgId).toBe(OWNER);
    expect(attackerInteraction?.correlationId).not.toBe(ownerInteraction?.correlationId);
  });

  it("events written for a no-context Ask carry the requesting org (attacker cannot inject into owner's events)", async () => {
    const { db } = buildDb();
    const { db: noContentDb } = (() => {
      const d: Record<string, unknown> = {
        execute: jest.fn().mockResolvedValue([]),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
      };
      d.transaction = jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(d));
      return { db: d as unknown as Db };
    })();

    const eventCalls: Array<[string, string, unknown]> = [];
    const events = {
      record: jest.fn().mockImplementation((orgId: string, type: string, opts: unknown) => {
        eventCalls.push([orgId, type, opts]);
        return Promise.resolve();
      }),
    };
    const svc = new KbAskService(
      noContentDb, {} as never, events as never, {} as never,
      { visibleArticles: jest.fn(), visiblePages: jest.fn(), visibleSources: jest.fn() } as never,
      NO_LINKED_DOCUMENTS,
    );

    await svc.ask(makeUser(ATTACKER), { question: "?" } as never);

    for (const [orgId] of eventCalls) {
      expect(orgId).toBe(ATTACKER);
      expect(orgId).not.toBe(OWNER);
    }
  });
});
