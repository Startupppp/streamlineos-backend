import { PgDialect } from "drizzle-orm/pg-core";
import { getTableName, type SQL, sql } from "drizzle-orm";
import { KbCitationVisibilityService } from "./kb-citation-visibility.service";
import { KbAskService } from "./kb-ask.service";
import { KbSearchService } from "./kb-search.service";
import { KbCandidateService } from "./kb-candidate.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

/**
 * Article visibility has TWO ACL dimensions: the owner DataScope, and the per-article
 * `kb_article_restrictions` rows. Retrieval applies both on the way in. The post-answer
 * citation re-verification — whose whole reason to exist is the window between retrieval
 * and the model's reply — re-applied only the owner half, so an article restricted during
 * that window was still handed back as a citation with its title, slug and space.
 *
 * The fake below is predicate-honouring in the same sense as `test/security/bola/kb-rag-fake-db.ts`:
 * the WHERE the service actually built is compiled with drizzle's own dialect and then
 * answered the way Postgres would for the dimension under test. The restriction SQL it is
 * answering is the production SQL — `KbCandidateService.articleRestrictionFilter` is the
 * real object here, not a stub — and the membership the fake enforces is read back out of
 * the compiled predicate, so "the restricted article is not cited" is a result of the SQL
 * rather than a restatement of the source text.
 */

const dialect = new PgDialect();

const OPEN_ARTICLE = { id: 10, title: "Leave policy", slug: "leave-policy" };
const RESTRICTED_ARTICLE = { id: 11, title: "Board compensation memo", slug: "board-comp" };

const ASKER_MEMBERSHIP = 7;
const PRIVILEGED_MEMBERSHIP = 999;

/** `kb_article_restrictions` rows: article 11 is viewable only by membership 999. */
const RESTRICTIONS = [
  { articleId: RESTRICTED_ARTICLE.id, membershipId: PRIVILEGED_MEMBERSHIP, level: "view" },
];

const MEMBERSHIP_COLUMN = '"kb_article_restrictions"."membership_id" = $';

interface CompiledWhere {
  sql: string;
  params: unknown[];
}

function compile(where: SQL | undefined): CompiledWhere {
  if (where === undefined) return { sql: "", params: [] };
  const query = dialect.sqlToQuery(where);
  return { sql: query.sql, params: query.params };
}

/** Article ids the predicate confines the read to. */
function articleIdsBoundIn(compiled: CompiledWhere): number[] | undefined {
  const marker = '"kb_articles"."id" in (';
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

/**
 * The membership id the restriction sub-predicate binds, or `undefined` when the
 * predicate carries no restriction clause at all — which is the unfixed behaviour.
 */
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
  };

  const makeDb = (): DbMock => {
    const db: DbMock = {
      execute: jest.fn().mockResolvedValue([{ one: 1 }]),
      select: jest.fn(() => ({
        from: jest.fn((table: unknown) => ({
          where: jest.fn((where: SQL) => {
            const name = getTableName(table as Parameters<typeof getTableName>[0]);
            if (name !== "kb_articles") return Promise.resolve([]);
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
      access as never,
      gateway as never,
      events as never,
      new KbCandidateService(db as never),
      scopes as never,
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
    jest.spyOn(search, "retrieveTopArticles").mockResolvedValue(retrieved);
    jest.spyOn(search, "retrieveTopSources").mockResolvedValue([]);
    jest.spyOn(search, "retrieveAttachmentSnippets").mockResolvedValue("");
    jest.spyOn(search, "articleOwnerFilterFor").mockResolvedValue(sql`true`);

    const ask = new KbAskService(
      db as never,
      gateway as never,
      events as never,
      search as never,
      access as never,
      new KbCitationVisibilityService(db as never, access as never, search as never),
    );
    return { ask, access };
  };

  beforeEach(() => {
    articleWheres.length = 0;
  });

  it("does not cite an article the asker's membership is restricted out of", async () => {
    const { ask } = buildService(false);

    const result = await ask.ask(makeUser(), { question: "what is the comp plan?" } as never);

    const citedIds = result.citations.map((c) => JSON.stringify(c)).join(" ");
    expect(citedIds).toContain(OPEN_ARTICLE.title);
    expect(citedIds).not.toContain(RESTRICTED_ARTICLE.title);
  });

  it("binds the ASKER's membership into the restriction predicate, never the article owner's", async () => {
    const { ask } = buildService(false);

    await ask.ask(makeUser(), { question: "what is the comp plan?" } as never);

    expect(articleWheres.length).toBeGreaterThan(0);
    for (const compiled of articleWheres) {
      expect(compiled.sql).toContain("kb_article_restrictions");
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
