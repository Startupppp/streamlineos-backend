import { readFileSync } from "node:fs";
import { join } from "node:path";

const BACKEND_ROOT = join(__dirname, "../..");

function src(rel: string): string {
  return readFileSync(join(BACKEND_ROOT, rel), "utf8");
}

describe("KB retrieval — ACL enforced as SQL predicate before model context (static analysis)", () => {
  const retrievalSrc = src("src/modules/kb/retrieval/kb-search-retrieval.service.ts");
  const kbCandidateSrc = src("src/modules/kb/retrieval/kb-candidate.service.ts");
  const topArticles = retrievalSrc.slice(retrievalSrc.indexOf("async retrieveTopArticlesWithOutcome("), retrievalSrc.indexOf("async retrieveDocumentPassagesWithOutcome("));
  const method = (name: string): string => {
    const start = kbCandidateSrc.indexOf(`async ${name}(`);
    return kbCandidateSrc.slice(start, kbCandidateSrc.indexOf("\n  async ", start + 1));
  };

  it("the asker's standing, which carries the accessible space ids, resolves before any candidate or row is read", () => {
    const standingPos = topArticles.search(/this\.auth\.resolveStanding\s*\(\s*user\s*\)/);
    const candidatePos = topArticles.search(/this\.candidates\.\w+Candidates\s*\(/);
    const dbSelectPos = topArticles.search(/this\.db\s*\.\s*select\s*\(/);
    expect(standingPos).toBeGreaterThan(-1);
    expect(candidatePos).toBeGreaterThan(standingPos);
    expect(dbSelectPos).toBeGreaterThan(standingPos);
    expect(topArticles).toMatch(/const ids = standing\.accessibleSpaceIds/);
  });

  it("no embedding is bought for an organisation with no embedded content — the BE-94 short-circuit precedes the provider call", () => {
    const guard = topArticles.search(/this\.aiGateway\.isEmbeddingConfigured\(\)\s*&&\s*\(await this\.candidates\.hasEmbeddedChunks\(user\.orgId\)\)/);
    const embed = topArticles.search(/this\.vectorFor\s*\(/);
    expect(guard).toBeGreaterThan(-1);
    expect(embed).toBeGreaterThan(guard);
    expect(topArticles).toMatch(/if \(fused\.length === 0\) return \{ kind: "empty", results: \[\] \}/);
  });

  it("articleKeywordCandidates binds orgId as an equality predicate", () => {
    expect(kbCandidateSrc).toMatch(/eq\s*\(\s*kbPages\.orgId\s*,\s*orgId\s*\)/);
  });

  it("both article candidate queries apply the accessible-space predicate and the restriction the retrieval resolved for the asker", () => {
    for (const name of ["articleKeywordCandidates", "articleVectorCandidates"]) {
      expect(method(name)).toContain("articleSpacePredicate(spaceIds)");
      expect(method(name)).toContain("if (restriction) conditions.push(restriction);");
    }
    expect(method("articleVectorCandidates")).toMatch(/this\.pageIdsNearest\s*\(\s*orgId\s*,/);
    expect(topArticles).toMatch(/this\.auth\.articleRestrictionPredicate\s*\(\s*user\s*\)/);
    expect(topArticles).toMatch(/articleVectorCandidates\(\s*user\.orgId\s*,\s*ids\s*,/);
  });

  it("both final fetches in retrieveTopArticles bind orgId, now that articles and pages share kb_pages", () => {
    const bindings = topArticles.match(/eq\s*\(\s*kbPages\.orgId\s*,\s*user\.orgId\s*\)/g) ?? [];
    expect(bindings.length).toBeGreaterThanOrEqual(2);
  });

  it("separates the two final fetches by content type, so one org-bound query cannot serve both surfaces", () => {
    expect(topArticles).toMatch(/supportArticlePredicate\s*\(\s*\)/);
    expect(topArticles).toMatch(/wikiPagePredicate\s*\(\s*\)/);
    expect(retrievalSrc).not.toMatch(/kbArticles\./);
  });
});

describe("Sign public routes — orgId derived from DB token record not from request (static analysis)", () => {
  const signPublicSrc = src("src/modules/e-sign/sign-public.service.ts");
  // withRecipientSession moved out of the service, unchanged, into the session seam every public
  // step imports (81bdc2851); the DB-derivation checks read it there.
  const recipientSessionSrc = src("src/modules/e-sign/lib/recipient-session.ts");
  const signPublicControllerSrc = src("src/modules/e-sign/sign-public.controller.ts");

  it("withRecipientSession resolves recipient from the DB by token hash — not from URL orgId", () => {
    expect(signPublicSrc).toMatch(/import \{ withRecipientSession\b[^}]*\} from "\.\/lib\/recipient-session"/);
    expect(recipientSessionSrc).toMatch(/withPublicToken\s*\(\s*(?:this\.)?db\s*,\s*hash/);
  });

  it("tenant transaction is opened with orgId from the DB recipient row not a request parameter", () => {
    expect(recipientSessionSrc).toMatch(/orgId:\s*recipient\.orgId/);
  });

  it("sign public controller has no orgId URL parameter — token is the sole tenant selector", () => {
    expect(signPublicControllerSrc).not.toMatch(/:orgId/);
    expect(signPublicControllerSrc).toMatch(/:token/);
  });

  it("sign public controller is @Public — rate-limited by token+ip not by authenticated orgId", () => {
    expect(signPublicControllerSrc).toMatch(/@Public\(\)/);
  });
});

describe("KB public pages — token is sole tenant selector with no request orgId", () => {
  const kbPublicSrc = src("src/modules/kb/wiki/kb-public-pages.controller.ts");

  it("controller is @Public and routes by :token only — no orgId in URL", () => {
    expect(kbPublicSrc).toMatch(/@Public\(\)/);
    expect(kbPublicSrc).toMatch(/"public\/wiki"/);
    expect(kbPublicSrc).not.toMatch(/:orgId/);
  });

  it("getPublicPage called with the token value only — no orgId passed from request", () => {
    expect(kbPublicSrc).toMatch(/getPublicPage\s*\(\s*parsed\.data\s*\)/);
  });
});
