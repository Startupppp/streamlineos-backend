import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchService } from "./kb-search.service";
import { buildArticleRestrictionBranch } from "../core/authorization/knowledge-page-scope";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG = "org-degrade";
const MEMBERSHIP = 9;
const ARTICLE_IDS = [11, 12];
const PAGE_IDS = [21];

const dialect = new PgDialect();

function render(cond: SQL): { text: string; params: unknown[] } {
  const query = dialect.sqlToQuery(cond);
  return { text: query.sql, params: query.params };
}

function boundOrgIds(cond: SQL, table: string): unknown[] {
  const { text, params } = render(cond);
  const pattern = new RegExp(`"${table}"\\."org_id"\\s*=\\s*\\$(\\d+)`, "g");
  return [...text.matchAll(pattern)].map((match) => params[Number(match[1]) - 1]);
}

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP, false),
  };
}

const passageRow = {
  content: "Reset your password from the account page.",
  chunkIndex: 0,
  pageId: 11,
  title: "Password reset",
};

const sourceRow = {
  sourceId: 31,
  title: "Handbook.pdf",
  spaceId: 1,
  updatedAt: new Date("2024-01-01T00:00:00Z"),
  content: "Expenses are reimbursed within 30 days.",
  chunkIndex: 0,
};

type EmbedBehaviour =
  | { mode: "ok" }
  | { mode: "failure"; kind: string }
  | { mode: "throws" };

function makeHarness(embed: EmbedBehaviour, resultQueue: unknown[][]) {
  const wheres: SQL[] = [];
  const orders: SQL[][] = [];
  const queue = [...resultQueue];
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(() => chain),
    innerJoin: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    where: jest.fn((cond: SQL) => {
      wheres.push(cond);
      return chain;
    }),
    orderBy: jest.fn((...args: SQL[]) => {
      orders.push(args);
      return chain;
    }),
    limit: jest.fn(() => Promise.resolve(queue.length > 1 ? queue.shift() : (queue[0] ?? []))),
  };
  const db = {
    select: jest.fn(() => chain),
    execute: jest.fn().mockResolvedValue([{ id: 7, chunk_count: 1 }]),
  };
  const embedQueryWithCredit = jest.fn();
  if (embed.mode === "ok")
    embedQueryWithCredit.mockResolvedValue({
      ok: true,
      vector: [0.1, 0.2],
      vectorLiteral: "[0.1,0.2]",
    });
  else if (embed.mode === "failure")
    embedQueryWithCredit.mockResolvedValue({
      ok: false,
      kind: embed.kind,
      message: "unavailable",
      correlationId: "corr-1",
    });
  else embedQueryWithCredit.mockRejectedValue(new Error("socket hang up"));

  const embeddings = {
    isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    embedQueryWithCredit,
  };
  const access = {
    getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
    getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
    isAdmin: jest.fn().mockResolvedValue(false),
    getPrincipalIds: jest
      .fn()
      .mockResolvedValue({ userId: "user-1", membershipId: MEMBERSHIP, roleSlugs: ["MEMBER"] }),
  };
  const auth = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest
      .fn()
      .mockResolvedValue({ orgId: ORG, pageId: 1, action: "view", via: "admin" }),
    articleRestrictionPredicate: jest.fn().mockResolvedValue(
      buildArticleRestrictionBranch(ORG, { membershipId: MEMBERSHIP, roleSlugs: ["MEMBER"] }),
    ),
  };
  const service = new KbSearchService(
    db as never,
    access as never,
    embeddings as never,
    { recordDetached: jest.fn().mockResolvedValue(undefined) } as never,
    new KbCandidateService(db as never),
    { scopeFor: jest.fn().mockResolvedValue("all") } as never,
    auth as never,
  );
  return { service, wheres, orders, embedQueryWithCredit };
}

describe("retrieveDocumentPassages degrades to lexical rather than answering with no passages", () => {
  it("still orders by vector distance when the embedding provider answers, so the happy path is unregressed", async () => {
    const { service, orders } = makeHarness({ mode: "ok" }, [[passageRow]]);

    const passages = await service.retrieveDocumentPassages(
      makeUser(),
      "password reset",
      ARTICLE_IDS,
      PAGE_IDS,
    );

    expect(passages).toHaveLength(1);
    expect(passages[0]?.degraded).toBeUndefined();
    expect(render(orders[0]?.[0] as SQL).text).toContain("<=>");
  });

  it("returns lexical passages rather than an empty list when embedQueryWithCredit reports the provider is unavailable", async () => {
    const { service, orders } = makeHarness({ mode: "failure", kind: "provider_unavailable" }, [
      [passageRow],
    ]);

    const passages = await service.retrieveDocumentPassages(
      makeUser(),
      "password reset",
      ARTICLE_IDS,
      PAGE_IDS,
    );

    expect(passages.length).toBeGreaterThan(0);
    expect(passages.every((passage) => passage.degraded === true)).toBe(true);
    expect(render(orders[0]?.[0] as SQL).text).toContain("ts_rank");
  });

  it("returns lexical passages rather than an empty list when embedQueryWithCredit throws", async () => {
    const { service } = makeHarness({ mode: "throws" }, [[passageRow]]);

    const passages = await service.retrieveDocumentPassages(
      makeUser(),
      "password reset",
      ARTICLE_IDS,
      PAGE_IDS,
    );

    expect(passages.length).toBeGreaterThan(0);
    expect(passages.every((passage) => passage.degraded === true)).toBe(true);
  });

  it("keeps the caller's org, the published status and the per-article restriction on the lexical fallback predicate", async () => {
    const { service, wheres } = makeHarness({ mode: "failure", kind: "provider_unavailable" }, [
      [passageRow],
    ]);

    await service.retrieveDocumentPassages(makeUser(), "password reset", ARTICLE_IDS, PAGE_IDS);

    const where = wheres[wheres.length - 1] as SQL;
    expect(boundOrgIds(where, "kb_article_chunks")).toEqual([ORG]);
    expect(boundOrgIds(where, "kb_pages")).toEqual([ORG]);
    const { text, params } = render(where);
    const status = /"kb_pages"\."status"\s*=\s*\$(\d+)/.exec(text);
    expect(params[Number(status?.[1]) - 1]).toBe("published");
    expect(text).toContain("kb_page_restrictions");
  });
});

describe("retrieveTopSources degrades to lexical rather than answering with no sources", () => {
  it("still orders by vector distance when the embedding provider answers, so the happy path is unregressed", async () => {
    const { service, orders } = makeHarness({ mode: "ok" }, [[{ id: 1 }], [sourceRow]]);

    const sources = await service.retrieveTopSources(makeUser(), "expense policy", 4);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.degraded).toBeUndefined();
    expect(sources[0]?.passages).toHaveLength(1);
    expect(render(orders[orders.length - 1]?.[0] as SQL).text).toContain("<=>");
  });

  it("returns lexical source documents rather than an empty list when embedQueryWithCredit reports the provider is unavailable", async () => {
    const { service, orders } = makeHarness({ mode: "failure", kind: "provider_unavailable" }, [
      [{ id: 1 }],
      [sourceRow],
    ]);

    const sources = await service.retrieveTopSources(makeUser(), "expense policy", 4);

    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((source) => source.degraded === true)).toBe(true);
    expect(render(orders[orders.length - 1]?.[0] as SQL).text).toContain("ts_rank");
  });

  it("returns lexical source documents rather than an empty list when embedQueryWithCredit throws", async () => {
    const { service } = makeHarness({ mode: "throws" }, [[{ id: 1 }], [sourceRow]]);

    const sources = await service.retrieveTopSources(makeUser(), "expense policy", 4);

    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((source) => source.degraded === true)).toBe(true);
  });

  it("keeps both tenant predicates and the accessible-space filter on the lexical fallback predicate", async () => {
    const { service, wheres } = makeHarness({ mode: "failure", kind: "provider_unavailable" }, [
      [{ id: 1 }],
      [sourceRow],
    ]);

    await service.retrieveTopSources(makeUser(), "expense policy", 4);

    const where = wheres[wheres.length - 1] as SQL;
    expect(boundOrgIds(where, "kb_article_chunks")).toEqual([ORG]);
    expect(boundOrgIds(where, "kb_sources")).toEqual([ORG]);
    const { text, params } = render(where);
    const status = /"kb_sources"\."status"\s*=\s*\$(\d+)/.exec(text);
    expect(params[Number(status?.[1]) - 1]).toBe("ready");
    expect(text).toMatch(/"kb_sources"\."space_id" is null/i);
    expect(text).toContain("deleted_at");
  });

  it("still short-circuits before spending a credit when the organization has indexed nothing", async () => {
    const { service, embedQueryWithCredit } = makeHarness({ mode: "ok" }, [[]]);

    const sources = await service.retrieveTopSources(makeUser(), "expense policy", 4);

    expect(sources).toEqual([]);
    expect(embedQueryWithCredit).not.toHaveBeenCalled();
  });
});
