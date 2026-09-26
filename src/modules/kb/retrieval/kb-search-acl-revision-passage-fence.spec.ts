import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbSearchService } from "./kb-search.service";
import { KbCandidateService } from "./kb-candidate.service";

const dialect = new PgDialect();

interface PassageFenceRow {
  chunkAclRevision: number;
  pageAclRevision: number;
  content: string;
  chunkIndex: number;
  pageId: number;
  title: string;
}

const STALE: PassageFenceRow = {
  chunkAclRevision: 1,
  pageAclRevision: 2,
  content: "stale-content-from-revoked-chunk",
  chunkIndex: 0,
  pageId: 200,
  title: "Article with revoked access",
};

const FRESH: PassageFenceRow = {
  chunkAclRevision: 3,
  pageAclRevision: 3,
  content: "fresh-content-from-valid-chunk",
  chunkIndex: 0,
  pageId: 201,
  title: "Article with valid access",
};

function extractFenceOp(join: SQL): string | null {
  const { sql: text } = dialect.sqlToQuery(join);
  const m =
    /"kb_article_chunks"\."acl_revision"\s*(=|>=|<=|<>|!=)\s*"kb_pages"\."acl_revision"/i.exec(
      text,
    );
  return m?.[1] ?? null;
}

function passageAdmitted(op: string | null, row: PassageFenceRow): boolean {
  if (op === "=") return row.chunkAclRevision === row.pageAclRevision;
  return true;
}

function makePassageFenceDb(rows: PassageFenceRow[]) {
  let capturedJoinCond: SQL | undefined;
  const node = (): Record<string, jest.Mock> => {
    const self: Record<string, jest.Mock> = {
      from: jest.fn(() => node()),
      innerJoin: jest.fn((_t: unknown, cond: SQL) => {
        capturedJoinCond = cond;
        return node();
      }),
      where: jest.fn(() => node()),
      orderBy: jest.fn(() => node()),
      limit: jest.fn(async () => {
        const op = capturedJoinCond !== undefined ? extractFenceOp(capturedJoinCond) : null;
        return rows
          .filter((r) => passageAdmitted(op, r))
          .map((r) => ({
            content: r.content,
            chunkIndex: r.chunkIndex,
            pageId: r.pageId,
            title: r.title,
          }));
      }),
      offset: jest.fn(() => node()),
    };
    return self;
  };
  return {
    db: {
      select: jest.fn(() => node()),
      execute: jest.fn().mockResolvedValue([]),
    } as Record<string, jest.Mock>,
    getCaptured: () => capturedJoinCond,
  };
}

function makeNoFenceDb(rows: PassageFenceRow[]) {
  const node = (): Record<string, jest.Mock> => {
    const self: Record<string, jest.Mock> = {
      from: jest.fn(() => node()),
      innerJoin: jest.fn(() => node()),
      where: jest.fn(() => node()),
      orderBy: jest.fn(() => node()),
      limit: jest.fn(async () =>
        rows.map((r) => ({
          content: r.content,
          chunkIndex: r.chunkIndex,
          pageId: r.pageId,
          title: r.title,
        })),
      ),
      offset: jest.fn(() => node()),
    };
    return self;
  };
  return {
    select: jest.fn(() => node()),
    execute: jest.fn().mockResolvedValue([]),
  } as Record<string, jest.Mock>;
}

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function makeAuth() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
    assertPageAccess: jest.fn(),
  };
}

function makeScopes() {
  return { scopeFor: jest.fn().mockResolvedValue("all") };
}

function makeEmbeddings() {
  return {
    isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    embedQueryWithCredit: jest.fn().mockResolvedValue({ ok: true, vectorLiteral: "[0.1,0.2]" }),
  };
}

function makeEvents() {
  return { recordDetached: jest.fn().mockResolvedValue(undefined) };
}

function makeSvc(db: Record<string, jest.Mock>): KbSearchService {
  return new KbSearchService(
    db as never,
    makeEmbeddings() as never,
    makeEvents() as never,
    new KbCandidateService(db as never),
    makeScopes() as never,
    makeAuth() as never,
  );
}

describe("ACL revision fence on retrieveDocumentPassages — stale chunk revision must not reach the prompt", () => {
  it("excludes the stale chunk and includes the fresh chunk when the fence is in the join", async () => {
    const { db } = makePassageFenceDb([STALE, FRESH]);
    const svc = makeSvc(db);

    const passages = await svc.retrieveDocumentPassages(
      makeUser(),
      "onboarding",
      [STALE.pageId, FRESH.pageId],
      [],
      { vectorLiteral: "[0.1,0.2]" },
    );

    const texts = passages.map((p) => p.text);
    expect(texts).not.toContain(STALE.content);
    expect(texts).toContain(FRESH.content);
  });

  it("BITE: without the fence the stale chunk's content reaches the prompt, proving the primary test above binds on the fence", async () => {
    const noFenceDb = makeNoFenceDb([STALE, FRESH]);
    const svc = makeSvc(noFenceDb);

    const passages = await svc.retrieveDocumentPassages(
      makeUser(),
      "onboarding",
      [STALE.pageId, FRESH.pageId],
      [],
      { vectorLiteral: "[0.1,0.2]" },
    );

    const texts = passages.map((p) => p.text);
    expect(texts).toContain(STALE.content);
    expect(texts).toContain(FRESH.content);
  });

});
