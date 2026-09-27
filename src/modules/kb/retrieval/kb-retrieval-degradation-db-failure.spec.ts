import { sql } from "drizzle-orm";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import { buildArticleRestrictionBranch } from "../core/authorization/knowledge-page-scope";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG = "org-dbfail";
const MEMBERSHIP = 99;

function makeUser(): CurrentUserContext {
  return {
    userId: "user-dbfail",
    orgId: ORG,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-dbfail",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP, false),
  };
}

function makeEmbeddings() {
  return {
    isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    embedQueryWithCredit: jest.fn().mockResolvedValue({
      ok: true,
      vector: [0.1, 0.2],
      vectorLiteral: "[0.1,0.2]",
    }),
  };
}

function makeAuth() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    articleRestrictionPredicate: jest.fn().mockResolvedValue(
      buildArticleRestrictionBranch(ORG, {
        membershipId: MEMBERSHIP,
        roleSlugs: ["MEMBER"],
      }),
    ),
    resolveStanding: jest.fn().mockResolvedValue({
      orgId: ORG,
      userId: "user-dbfail",
      membershipId: MEMBERSHIP,
      roleSlugs: ["MEMBER"],
      isOrgOwner: false,
      isKbAdmin: false,
      accessibleSpaceIds: [1],
      accessibleProjectIds: [],
      permissionsVersion: 1,
    }),
  };
}

type PassageBehavior = "returns-empty" | "throws";

function makePassageHarness(behavior: PassageBehavior) {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(() => chain),
    innerJoin: jest.fn(() => chain),
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit:
      behavior === "returns-empty"
        ? jest.fn().mockResolvedValue([])
        : jest.fn().mockRejectedValue(new Error("connection timeout")),
  };
  const db = {
    select: jest.fn(() => chain),
    execute: jest.fn().mockResolvedValue([]),
  };
  const service = new KbSearchRetrievalService(
    db as never,
    makeEmbeddings() as never,
    new KbCandidateService(db as never),
    { scopeFor: jest.fn().mockResolvedValue("all") } as never,
    makeAuth() as never,
  );
  return { service, db };
}

type SourceBehavior = "returns-empty" | "throws" | "no-chunks";

function makeSourceHarness(behavior: SourceBehavior) {
  if (behavior === "no-chunks") {
    const chain: Record<string, jest.Mock> = {
      from: jest.fn(() => chain),
      where: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      select: jest.fn(() => chain),
      execute: jest.fn().mockResolvedValue([]),
    };
    const service = new KbSearchRetrievalService(
      db as never,
      makeEmbeddings() as never,
      new KbCandidateService(db as never),
      { scopeFor: jest.fn().mockResolvedValue("all") } as never,
      makeAuth() as never,
    );
    return { service, db };
  }

  let selectCallIndex = 0;
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(() => chain),
    innerJoin: jest.fn(() => chain),
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn().mockImplementation(() => {
      const call = selectCallIndex++;
      if (call === 0) return Promise.resolve([{ id: 1 }]);
      if (behavior === "returns-empty") return Promise.resolve([]);
      return Promise.reject(new Error("connection timeout"));
    }),
  };
  const db = {
    select: jest.fn(() => chain),
    execute: jest.fn().mockResolvedValue([{ id: 1, chunk_count: 1 }]),
  };
  const service = new KbSearchRetrievalService(
    db as never,
    makeEmbeddings() as never,
    new KbCandidateService(db as never),
    { scopeFor: jest.fn().mockResolvedValue("all") } as never,
    makeAuth() as never,
  );
  return { service, db };
}

describe("retrieveDocumentPassagesWithOutcome — FAILED vs EMPTY outcome distinction", () => {
  it("FAILED: when the DB query throws after embedding succeeds the outcome kind is 'failed' not 'empty'", async () => {
    const { service } = makePassageHarness("throws");

    const outcome = await service.retrieveDocumentPassagesWithOutcome(
      makeUser(),
      "password reset",
      [11],
      [],
    );

    expect(outcome.kind).toBe("failed");
    expect(outcome.results).toEqual([]);
  });

  it("CONTROL empty: when the DB returns zero rows after successful embedding the outcome kind is 'empty' not 'failed'", async () => {
    const { service } = makePassageHarness("returns-empty");

    const outcome = await service.retrieveDocumentPassagesWithOutcome(
      makeUser(),
      "password reset",
      [11],
      [],
    );

    expect(outcome.kind).toBe("empty");
    expect(outcome.results).toEqual([]);
  });

  it("DISABLED: when both articleIds and pageIds are empty the outcome kind is 'disabled' and the DB is not queried", async () => {
    const { service, db } = makePassageHarness("returns-empty");

    const outcome = await service.retrieveDocumentPassagesWithOutcome(
      makeUser(),
      "password reset",
      [],
      [],
    );

    expect(outcome.kind).toBe("disabled");
    expect(outcome.results).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("retrieveTopSourcesWithOutcome — FAILED vs EMPTY outcome distinction", () => {
  it("FAILED: when the DB query throws after embedding and chunk lookup succeed the outcome kind is 'failed' not 'empty'", async () => {
    const { service } = makeSourceHarness("throws");

    const outcome = await service.retrieveTopSourcesWithOutcome(
      makeUser(),
      "expense policy",
      4,
    );

    expect(outcome.kind).toBe("failed");
    expect(outcome.results).toEqual([]);
  });

  it("CONTROL empty: when the DB returns zero rows after successful embedding the outcome kind is 'empty' not 'failed'", async () => {
    const { service } = makeSourceHarness("returns-empty");

    const outcome = await service.retrieveTopSourcesWithOutcome(
      makeUser(),
      "expense policy",
      4,
    );

    expect(outcome.kind).toBe("empty");
    expect(outcome.results).toEqual([]);
  });

  it("DISABLED: when the org has no embedded chunks the outcome kind is 'disabled'", async () => {
    const { service } = makeSourceHarness("no-chunks");

    const outcome = await service.retrieveTopSourcesWithOutcome(
      makeUser(),
      "expense policy",
      4,
    );

    expect(outcome.kind).toBe("disabled");
    expect(outcome.results).toEqual([]);
  });
});
