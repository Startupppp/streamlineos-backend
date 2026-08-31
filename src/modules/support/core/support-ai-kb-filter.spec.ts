import { SupportAiTriageService } from "./support-ai-triage.service";
import { SupportAiSettingsService } from "./support-ai-settings.service";
import { SupportAiEmbeddingsHelper } from "./support-ai-embeddings.helper";

const EMBEDDING_DIM = 1536;

const makeGateway = () => ({
  invokeStructured: jest.fn(),
  invokeText: jest.fn(),
});
const makeEmbeddings = () => ({
  isConfigured: jest.fn().mockReturnValue(true),
  embedQuery: jest.fn().mockResolvedValue(new Array(EMBEDDING_DIM).fill(0.1)),
  toVectorLiteral: jest.fn((v: number[]) => `[${v.join(",")}]`),
});
const makeOrgFeatures = () => ({ getFlags: jest.fn().mockResolvedValue({ supportAi: true }) });
const makeAiSettings = (): Partial<SupportAiSettingsService> => ({ getSettings: jest.fn().mockResolvedValue({ confidenceThreshold: 0.7 }) });
const makeEmbHelper = (): Partial<SupportAiEmbeddingsHelper> => ({
  upsertAndSearchSimilar: jest.fn().mockResolvedValue([]),
  getDuplicateThreshold: jest.fn().mockReturnValue(0.86),
  getRootCauseThreshold: jest.fn().mockReturnValue(0.75),
});
const makeKbAccess = () => ({
  getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
  getPrincipalIds: jest.fn().mockResolvedValue({ userId: "u1", roleSlugs: [] }),
});

const makeChain = (finalValue: unknown[] = []) => {
  const chain: Record<string, jest.Mock> = {};
  for (const m of ["from", "where", "orderBy", "innerJoin", "leftJoin"]) {
    chain[m] = jest.fn().mockReturnThis();
  }
  chain.limit = jest.fn().mockResolvedValue(finalValue);
  return chain;
};

describe("SupportAiTriageService.suggestKbArticles — KB filter", () => {
  it("returns null when no articles meet similarity threshold", async () => {
    const lowSimilarityRow = [{ articleId: 1, title: "irrelevant", slug: "irrelevant", similarity: 0.05 }];

    const chain = makeChain(lowSimilarityRow);
    const db = {
      select: jest.fn().mockReturnValue(chain),
      query: {
        supportTickets: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1", title: "bug", description: null }),
        },
      },
    };

    const svc = new SupportAiTriageService(
      db as never,
      makeGateway() as never,
      makeEmbeddings() as never,
      makeOrgFeatures() as never,
      makeAiSettings() as never,
      makeEmbHelper() as never,
      makeKbAccess() as never,
    );

    const result = await svc.suggestKbArticles("org-1" as never, 1);
    expect(result).toBeNull();
  });

  it("uses two innerJoins (kbArticles + kbSpaces) for filtering", async () => {
    const chain = makeChain([]);
    const db = {
      select: jest.fn().mockReturnValue(chain),
      query: {
        supportTickets: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1", title: "bug", description: null }),
        },
      },
    };

    const svc = new SupportAiTriageService(
      db as never,
      makeGateway() as never,
      makeEmbeddings() as never,
      makeOrgFeatures() as never,
      makeAiSettings() as never,
      makeEmbHelper() as never,
      makeKbAccess() as never,
    );

    await svc.suggestKbArticles("org-1" as never, 1);

    expect(chain.innerJoin).toHaveBeenCalledTimes(2);
  });

  it("returns null when embedding service is not configured", async () => {
    const embeddings = {
      isConfigured: jest.fn().mockReturnValue(false),
      embedQuery: jest.fn(),
      toVectorLiteral: jest.fn(),
    };
    const db = {
      query: {
        supportTickets: { findFirst: jest.fn() },
      },
    };

    const svc = new SupportAiTriageService(
      db as never,
      makeGateway() as never,
      embeddings as never,
      makeOrgFeatures() as never,
      makeAiSettings() as never,
      makeEmbHelper() as never,
      makeKbAccess() as never,
    );

    const result = await svc.suggestKbArticles("org-1" as never, 1);
    expect(result).toBeNull();
    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });
});
