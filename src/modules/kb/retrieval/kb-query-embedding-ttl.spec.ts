import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import { KbCandidateService } from "./kb-candidate.service";

function makeDb() {
  return {
    execute: jest.fn().mockResolvedValue([{ one: 1 }]),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
  };
}

function makeCache() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
}

const makeAuth = () => ({
  visiblePagePredicate: jest.fn(),
  resolveStanding: jest.fn().mockResolvedValue({
    orgId: "org-a",
    userId: "u",
    membershipId: 1,
    roleSlugs: [],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: [],
    accessibleProjectIds: [],
    permissionsVersion: 1,
  }),
  articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
  resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [], cacheOutcome: "miss" }),
});

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

describe("KbSearchRetrievalService — query embedding cache TTL", () => {
  it("caches the query embedding for 7 days because embeddings are deterministic and caching per hour charges the org 168x more per unique question than caching per week", async () => {
    const cache = makeCache();
    const db = makeDb();
    const aiGateway = {
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
      embedQueryWithCredit: jest
        .fn()
        .mockResolvedValue({ ok: true, vectorLiteral: "[0.1,0.2]" }),
    };

    const svc = new KbSearchRetrievalService(
      db as never,
      aiGateway as never,
      new KbCandidateService(db as never, null),
      { scopeFor: jest.fn() } as never,
      makeAuth() as never,
      cache as never,
    );

    await svc.resolveQueryEmbedding("how do I reset my password", "org-a");

    expect(cache.set).toHaveBeenCalledTimes(1);
    const [, , ttl] = cache.set.mock.calls[0] as [string, string, number];
    expect(ttl).toBe(SEVEN_DAYS_SECONDS);
  });

  it("CONTROL: CACHE_TTL.HOUR is not 7 days, so the TTL assertion above is not trivially satisfied by the pre-existing hourly constant", () => {
    const { CACHE_TTL } = jest.requireActual<typeof import("../../../common/cache/cache-keys")>(
      "../../../common/cache/cache-keys",
    );
    expect(CACHE_TTL.HOUR).not.toBe(SEVEN_DAYS_SECONDS);
  });
});
