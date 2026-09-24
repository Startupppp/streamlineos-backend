import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchService } from "./kb-search.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG = "org-attach";
const MEMBERSHIP = 4;
const ARTICLE_IDS = [11, 12];

const dialect = new PgDialect();

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

function render(cond: SQL): { text: string; params: unknown[] } {
  const query = dialect.sqlToQuery(cond);
  return { text: query.sql, params: query.params };
}

function boundOrgIds(cond: SQL, table: string): unknown[] {
  const { text, params } = render(cond);
  const pattern = new RegExp(`"${table}"\\."org_id"\\s*=\\s*\\$(\\d+)`, "g");
  return [...text.matchAll(pattern)].map((match) => params[Number(match[1]) - 1]);
}

function makeHarness(options: { scope?: string; isAdmin?: boolean } = {}) {
  const wheres: SQL[] = [];
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(() => chain),
    innerJoin: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    where: jest.fn((cond: SQL) => {
      wheres.push(cond);
      return chain;
    }),
    orderBy: jest.fn(() => chain),
    limit: jest.fn().mockResolvedValue([]),
  };
  const db = {
    select: jest.fn(() => chain),
    execute: jest.fn().mockResolvedValue([]),
  };
  const access = {
    getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
    getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
    isAdmin: jest.fn().mockResolvedValue(options.isAdmin ?? false),
    getPrincipalIds: jest
      .fn()
      .mockResolvedValue({ userId: "user-1", membershipId: MEMBERSHIP, roleSlugs: ["MEMBER"] }),
  };
  const embeddings = {
    isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    embedQueryWithCredit: jest
      .fn()
      .mockResolvedValue({ ok: true, vector: [0.1, 0.2], vectorLiteral: "[0.1,0.2]" }),
  };
  const auth = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
  };
  const service = new KbSearchService(
    db as never,
    access as never,
    embeddings as never,
    { recordDetached: jest.fn().mockResolvedValue(undefined) } as never,
    new KbCandidateService(db as never),
    { scopeFor: jest.fn().mockResolvedValue(options.scope ?? "all") } as never,
    auth as never,
  );
  return { service, wheres };
}

describe("retrieveDocumentPassages applies the article ACL itself", () => {
  it("binds the caller's org and the published status to kb_pages, not just the id list", async () => {
    const { service, wheres } = makeHarness();

    await service.retrieveDocumentPassages(makeUser(), "expense policy", ARTICLE_IDS);

    expect(wheres).toHaveLength(1);
    const where = wheres[0];
    expect(boundOrgIds(where, "kb_pages")).toEqual([ORG]);
    expect(boundOrgIds(where, "kb_article_chunks")).toEqual([ORG]);
    const { text, params } = render(where);
    const status = /"kb_pages"\."status"\s*=\s*\$(\d+)/.exec(text);
    expect(status).not.toBeNull();
    expect(params[Number(status?.[1]) - 1]).toBe("published");
  });

  it("pushes the per-article restriction subquery for a non-admin reader", async () => {
    const { service, wheres } = makeHarness();

    await service.retrieveDocumentPassages(makeUser(), "expense policy", ARTICLE_IDS);

    const { text } = render(wheres[0]);
    expect(text).toContain("kb_page_restrictions");
    expect(text).toMatch(/not exists/i);
  });

  it("narrows an own-scoped reader to their own articles", async () => {
    const { service, wheres } = makeHarness({ scope: "own" });

    await service.retrieveDocumentPassages(makeUser(), "expense policy", ARTICLE_IDS);

    const { text, params } = render(wheres[0]);
    const owner = /"kb_pages"\."owner_membership_id"\s*=\s*\$(\d+)/.exec(text);
    expect(owner).not.toBeNull();
    expect(params[Number(owner?.[1]) - 1]).toBe(MEMBERSHIP);
  });

  it("denies outright when the reader holds no scope for kb:articles:view", async () => {
    const { service, wheres } = makeHarness({ scope: "none" });

    await service.retrieveDocumentPassages(makeUser(), "expense policy", ARTICLE_IDS);

    expect(render(wheres[0]).text).toContain("false");
  });

  it("leaves a kb:spaces:manage holder unrestricted, matching the direct read path", async () => {
    const { service, wheres } = makeHarness({ isAdmin: true });

    await service.retrieveDocumentPassages(makeUser(), "expense policy", ARTICLE_IDS);

    const { text } = render(wheres[0]);
    expect(text).not.toContain("kb_page_restrictions");
    expect(boundOrgIds(wheres[0], "kb_pages")).toEqual([ORG]);
  });
});
