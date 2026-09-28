import { PgDialect } from "drizzle-orm/pg-core";
import { getTableName, type SQL, sql } from "drizzle-orm";
import { NotFoundException } from "@nestjs/common";
import { KbCitationVisibilityService } from "./kb-citation-visibility.service";
import { KbAskService } from "./kb-ask.service";
import { KbAskCitationService } from "./kb-ask-citations.service";
import { KbSearchService } from "./kb-search.service";
import { KbCandidateService, kbPageCoreProjection, type KbPageCoreFields } from "./kb-candidate.service";
import { humanSessionPrincipal, actingMembershipId } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { buildArticleRestrictionBranch } from "../core/authorization/knowledge-page-scope";
import type { AskCitation } from "./kb-ask.service";
import type { CitableTop } from "./kb-ask-citations.service";
import { NO_LINKED_DOCUMENTS } from "../../../test/kb-linked-document-ask-source.spec-fixtures";


const dialect = new PgDialect();

const OPEN_ARTICLE = { id: 10, title: "Leave policy", slug: "leave-policy" };
const RESTRICTED_ARTICLE = { id: 11, title: "Board compensation memo", slug: "board-comp" };

const ASKER_MEMBERSHIP = 7;
const PRIVILEGED_MEMBERSHIP = 999;

const RESTRICTIONS = [
  { articleId: RESTRICTED_ARTICLE.id, membershipId: PRIVILEGED_MEMBERSHIP, level: "view" },
];

const MEMBERSHIP_COLUMN = '"kb_page_restrictions"."membership_id" = $';

interface CompiledWhere {
  sql: string;
  params: unknown[];
}

function compile(where: SQL | undefined): CompiledWhere {
  if (where === undefined) return { sql: "", params: [] };
  const query = dialect.sqlToQuery(where);
  return { sql: query.sql, params: query.params };
}

function articleIdsBoundIn(compiled: CompiledWhere): number[] | undefined {
  const marker = '"kb_pages"."id" in (';
  const at = compiled.sql.indexOf(marker);
  if (at === -1) return undefined;
  const close = compiled.sql.indexOf(")", at);
  const ids: number[] = [];
  for (const token of compiled.sql.slice(at + marker.length, close).split(",")) {
    const index = Number.parseInt(token.trim().replace("$", ""), 10);
    const value = compiled.params[index - 1];
    if (typeof value === "number") ids.push(value);
  }
  return ids;
}

function restrictionMembershipIn(compiled: CompiledWhere): number | undefined {
  const at = compiled.sql.indexOf(MEMBERSHIP_COLUMN);
  if (at === -1) return undefined;
  const index = Number.parseInt(compiled.sql.slice(at + MEMBERSHIP_COLUMN.length), 10);
  const value = compiled.params[index - 1];
  return typeof value === "number" ? value : undefined;
}

function makeUser(): CurrentUserContext {
  return {
    userId: "user-asker",
    orgId: "org-1",
    role: "member",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(ASKER_MEMBERSHIP, false),
  } as CurrentUserContext;
}

describe("KbAskService — citation re-verification re-applies the article-restriction ACL", () => {
  const articleWheres: CompiledWhere[] = [];

  type DbMock = {
    execute: jest.Mock;
    select: jest.Mock;
    transaction: jest.Mock;
    insert: jest.Mock;
    insertedRows: Record<string, unknown>[];
  };

  const makeDb = (): DbMock => {
    const insertedRows: Record<string, unknown>[] = [];
    const db: DbMock = {
      execute: jest.fn().mockResolvedValue([{ one: 1 }]),
      insertedRows,
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
          insertedRows.push(row);
          return Promise.resolve([]);
        }),
      })),
      select: jest.fn(() => ({
        from: jest.fn((table: unknown) => ({
          where: jest.fn((where: SQL) => {
            const name = getTableName(table as Parameters<typeof getTableName>[0]);
            if (name !== "kb_pages") return Promise.resolve([]);
            const compiled = compile(where);
            articleWheres.push(compiled);
            const allowed = articleIdsBoundIn(compiled);
            const membership = restrictionMembershipIn(compiled);
            const rows = [OPEN_ARTICLE, RESTRICTED_ARTICLE]
              .filter((a) => allowed === undefined || allowed.includes(a.id))
              .filter((a) => {
                const rules = RESTRICTIONS.filter(
                  (r) => r.articleId === a.id && r.level === "view",
                );
                if (rules.length === 0) return true;
                if (membership === undefined) return true;
                return rules.some((r) => r.membershipId === membership);
              })
              .map((a) => ({ id: a.id }));
            return Promise.resolve(rows);
          }),
        })),
      })),
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
    };
    return db;
  };

  const buildService = (isAdmin: boolean) => {
    const db = makeDb();
    const access = {
      getAccessibleSpaceIds: jest.fn().mockResolvedValue([5]),
      isAdmin: jest.fn().mockResolvedValue(isAdmin),
      getPrincipalIds: jest.fn().mockResolvedValue({
        userId: "user-asker",
        membershipId: ASKER_MEMBERSHIP,
        roleSlugs: [],
      }),
    };
    const auth = {
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
      resolveStanding: jest.fn().mockResolvedValue({ orgId: "org-1", userId: "user-asker", membershipId: ASKER_MEMBERSHIP, roleSlugs: [], isOrgOwner: false, isKbAdmin: false, accessibleSpaceIds: [5], accessibleProjectIds: [], permissionsVersion: 1 }),
      assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
      articleRestrictionPredicate: jest.fn().mockImplementation(async (user: CurrentUserContext) => {
        if (await access.isAdmin(user)) return null;
        const membershipId = user.principal !== undefined ? actingMembershipId(user.principal) : null;
        return buildArticleRestrictionBranch(user.orgId, { membershipId, roleSlugs: [] });
      }),
    };
    const gateway = {
      invokeTextWithUsage: jest.fn().mockResolvedValue({
        ok: true,
        data: "Here is the answer.",
        aiUsage: {
          model: "gpt-4o-mini",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          credits: 1,
          costUsd: 0.001,
        },
      }),
    };
    const events = { record: jest.fn().mockResolvedValue(undefined) };
    const scopes = { scopeFor: jest.fn().mockResolvedValue("all") };

    const search = new KbSearchService(
      db as never,
      events as never,
      new KbCandidateService(db as never),
      scopes as never,
      auth as never,
    );

    const retrieved = [OPEN_ARTICLE, RESTRICTED_ARTICLE].map((a) => ({
      kind: "article" as const,
      id: a.id,
      title: a.title,
      slug: a.slug,
      spaceId: 5,
      contentText: `text for ${a.slug}`,
      updatedAt: new Date("2024-01-01"),
    }));
    jest.spyOn(search, "aclCacheOutcome").mockResolvedValue("bypass");
    jest.spyOn(search, "articleOwnerFilterFor").mockResolvedValue(sql`true`);

    const retrieval = {
      retrieve: jest.fn().mockResolvedValue({
        documents: retrieved,
        sources: [],
        passages: [],
        degraded: { kind: "none" as const },
        strategy: { kind: "exact" as const },
      }),
    };

    const ask = new KbAskService(
      db as never,
      gateway as never,
      events as never,
      search as never,
      new KbAskCitationService(db as never, new KbCitationVisibilityService(db as never, search as never, auth as never), NO_LINKED_DOCUMENTS) as never,
      NO_LINKED_DOCUMENTS, null,
      retrieval as never,
    );
    return { ask, access, db };
  };

  beforeEach(() => {
    articleWheres.length = 0;
  });

  it("does not cite an article the asker's membership is restricted out of", async () => {
    const { ask, db } = buildService(false);

    const result = await ask.ask(makeUser(), { question: "what is the comp plan?" } as never);

    const citedIds = result.citations.map((c) => JSON.stringify(c)).join(" ");
    expect(citedIds).toContain(OPEN_ARTICLE.title);
    expect(citedIds).not.toContain(RESTRICTED_ARTICLE.title);
    expect(db.insertedRows.some((r) => r["resultState"] === "answered")).toBe(true);
  });

  it("binds the ASKER's membership into the restriction predicate, never the article owner's", async () => {
    const { ask } = buildService(false);

    await ask.ask(makeUser(), { question: "what is the comp plan?" } as never);

    expect(articleWheres.length).toBeGreaterThan(0);
    for (const compiled of articleWheres) {
      expect(compiled.sql).toContain("kb_page_restrictions");
      expect(restrictionMembershipIn(compiled)).toBe(ASKER_MEMBERSHIP);
    }
  });

  it("is not a blanket denial — a kb:spaces:manage holder still gets both citations", async () => {
    const { ask, access } = buildService(true);

    const result = await ask.ask(makeUser(), { question: "what is the comp plan?" } as never);

    expect(access.isAdmin).toHaveBeenCalled();
    const cited = result.citations.map((c) => JSON.stringify(c)).join(" ");
    expect(cited).toContain(OPEN_ARTICLE.title);
    expect(cited).toContain(RESTRICTED_ARTICLE.title);
  });
});

describe("KbAskService — page citation: visiblePagePredicate applied on re-verification", () => {
  const CITED_PAGE_ID = 55;

  const pageCitation: AskCitation = {
    kind: "page",
    pageId: CITED_PAGE_ID,
    title: "Org policy document",
    spaceId: 5,
    updatedAt: new Date("2024-01-01"),
  };

  const pageWheres: CompiledWhere[] = [];

  function onlyKbPagesWheres(): CompiledWhere[] {
    return pageWheres.filter((compiled) => compiled.sql.includes("kb_pages"));
  }

  function pageIdsBoundIn(compiled: CompiledWhere): number[] | undefined {
    const marker = '"kb_pages"."id" in (';
    const at = compiled.sql.indexOf(marker);
    if (at === -1) return undefined;
    const close = compiled.sql.indexOf(")", at);
    const ids: number[] = [];
    for (const token of compiled.sql.slice(at + marker.length, close).split(",")) {
      const index = Number.parseInt(token.trim().replace("$", ""), 10);
      const value = compiled.params[index - 1];
      if (typeof value === "number") ids.push(value);
    }
    return ids;
  }

  function predicateLiteralIn(compiled: CompiledWhere): boolean | undefined {
    const tokens = compiled.sql
      .replace(/^\(/, "")
      .replace(/\)$/, "")
      .split(" and ")
      .map((token) => token.trim());
    const last = tokens[tokens.length - 1];
    if (last === "true") return true;
    if (last === "false") return false;
    return undefined;
  }

  function makeDbForRevocation() {
    const db: Record<string, unknown> = {
      execute: jest.fn().mockResolvedValue([]),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((where: SQL) => {
            const compiled = compile(where);
            pageWheres.push(compiled);
            const boundIds = pageIdsBoundIn(compiled);
            const predicateTrue = predicateLiteralIn(compiled);
            const visible =
              predicateTrue === true &&
              (boundIds === undefined || boundIds.includes(CITED_PAGE_ID));
            return Promise.resolve(visible ? [{ id: CITED_PAGE_ID }] : []);
          }),
        }),
      }),
    };
    db.transaction = jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
    return db;
  }

  beforeEach(() => {
    pageWheres.length = 0;
  });

  it("revoking access to a cited page redacts the citation on re-open", async () => {
    const db = makeDbForRevocation();
    const authRevoked = {
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`false`),
      assertPageAccess: jest.fn(),
    };
    const svc = new KbAskCitationService(
      db as never,
      new KbCitationVisibilityService(db as never, {} as never, authRevoked as never),
      NO_LINKED_DOCUMENTS,
    );

    await expect(svc.assertReplayCitations(makeUser(), [pageCitation])).rejects.toThrow(NotFoundException);
    const kbPagesWheres = onlyKbPagesWheres();
    expect(kbPagesWheres).toHaveLength(1);
    expect(kbPagesWheres[0].sql).toContain('"kb_pages"."id" in (');
    expect(predicateLiteralIn(kbPagesWheres[0])).toBe(false);
  });

  it("a page citation accessible to the asker passes re-verification (positive pair)", async () => {
    const db = makeDbForRevocation();
    const authGrants = {
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
      assertPageAccess: jest.fn(),
    };
    const svc = new KbAskCitationService(
      db as never,
      new KbCitationVisibilityService(db as never, {} as never, authGrants as never),
      NO_LINKED_DOCUMENTS,
    );

    await expect(svc.assertReplayCitations(makeUser(), [pageCitation])).resolves.not.toThrow();
    const kbPagesWheres = onlyKbPagesWheres();
    expect(kbPagesWheres).toHaveLength(1);
    expect(predicateLiteralIn(kbPagesWheres[0])).toBe(true);
    expect(pageIdsBoundIn(kbPagesWheres[0])).toEqual([CITED_PAGE_ID]);
  });
});

describe("search/citation core-projection parity — kbPageCoreProjection and CitableTop derive from the same declared field set", () => {
  const CORE_FIELD_KEYS: readonly (keyof Required<KbPageCoreFields>)[] = [
    "id",
    "title",
    "spaceId",
    "updatedAt",
    "slug",
  ];

  it("kbPageCoreProjection contains a column entry for every field in KbPageCoreFields so a field added to the type without a column mapping is a compile-time error", () => {
    for (const key of CORE_FIELD_KEYS) {
      expect(kbPageCoreProjection).toHaveProperty(key);
    }
    expect(Object.keys(kbPageCoreProjection)).toHaveLength(CORE_FIELD_KEYS.length);
  });

  it("CitableTop satisfies KbPageCoreFields so the citation interface cannot silently drop a core field", () => {
    const top: CitableTop = {
      kind: "article",
      id: 42,
      title: "Onboarding guide",
      spaceId: null,
      updatedAt: new Date("2024-01-01"),
    };
    const core: KbPageCoreFields = top;
    expect(core.id).toBe(top.id);
    expect(core.title).toBe(top.title);
    expect(core.updatedAt).toBe(top.updatedAt);
  });

  it("BITE: a projection missing one core field does not satisfy the length invariant, so the assertion above is not vacuous", () => {
    const withoutSlug = { id: 1, title: "T", spaceId: null, updatedAt: new Date() };
    expect(Object.keys(withoutSlug)).not.toHaveLength(CORE_FIELD_KEYS.length);
    expect(Object.keys(kbPageCoreProjection)).toHaveLength(CORE_FIELD_KEYS.length);
  });
});
