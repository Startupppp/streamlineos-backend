import { SupportAiService } from "./support-ai.service";
import { AiGatewayService } from "../ai/gateway/ai-gateway.service";
import { EmbeddingsService } from "../ai/providers/embeddings.service";
import { OrgFeaturesService } from "../ai/services/org-features.service";

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

const makeChain = (finalValue: unknown[] = []) => {
  const chain: Record<string, jest.Mock> = {};
  for (const m of ["from", "where", "orderBy", "innerJoin", "leftJoin"]) {
    chain[m] = jest.fn().mockReturnThis();
  }
  chain.limit = jest.fn().mockResolvedValue(finalValue);
  return chain;
};

describe("SupportAiService.suggestKbArticles — KB filter", () => {
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

    const svc = new SupportAiService(
      db as never,
      makeGateway() as never,
      makeEmbeddings() as never,
      makeOrgFeatures() as never,
    );

    const result = await svc.suggestKbArticles("org-1", 1);
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

    const svc = new SupportAiService(
      db as never,
      makeGateway() as never,
      makeEmbeddings() as never,
      makeOrgFeatures() as never,
    );

    await svc.suggestKbArticles("org-1", 1);

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

    const svc = new SupportAiService(
      db as never,
      makeGateway() as never,
      embeddings as never,
      makeOrgFeatures() as never,
    );

    const result = await svc.suggestKbArticles("org-1", 1);
    expect(result).toBeNull();
    expect(embeddings.embedQuery).not.toHaveBeenCalled();
  });
});
