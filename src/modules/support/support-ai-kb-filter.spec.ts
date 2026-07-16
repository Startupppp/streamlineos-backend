import { SupportAiService } from "./support-ai.service";
import { LlmService } from "../ai/providers/llm.service";
import { EmbeddingsService } from "../ai/providers/embeddings.service";
import { AiUsageService } from "../ai/services/ai-usage.service";
import { OrgFeaturesService } from "../ai/services/org-features.service";

const EMBEDDING_DIM = 1536;

const makeLlm = () => ({ isConfigured: jest.fn().mockReturnValue(false), invokeText: jest.fn(), invokeStructured: jest.fn() });
const makeEmbeddings = () => ({
  isConfigured: jest.fn().mockReturnValue(true),
  embedQuery: jest.fn().mockResolvedValue(new Array(EMBEDDING_DIM).fill(0.1)),
  toVectorLiteral: jest.fn((v: number[]) => `[${v.join(",")}]`),
});
const makeAiUsage = () => ({ track: jest.fn().mockResolvedValue(undefined) });
const makeOrgFeatures = () => ({ getFlags: jest.fn().mockResolvedValue({ supportAi: true }) });

describe("SupportAiService.suggestKbArticles — KB filter", () => {
  it("filters out draft and archived articles by querying only published ones", async () => {
    const selectResult: unknown[] = [];
    const db: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(selectResult),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(selectResult),
      query: {
        supportTickets: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1", title: "bug", description: null }),
        },
      },
    };

    db.limit = jest.fn().mockResolvedValue([]);

    const svc = new SupportAiService(
      db as never,
      makeLlm() as never,
      makeEmbeddings() as never,
      makeAiUsage() as never,
      makeOrgFeatures() as never,
    );

    const result = await svc.suggestKbArticles("org-1", 1);

    expect(result).toBeNull();
    expect((db.innerJoin as jest.Mock)).toHaveBeenCalledTimes(2);
  });

  it("returns null when no articles match the similarity threshold", async () => {
    const lowSimilarityRow = [{ articleId: 1, title: "irrelevant", slug: "irrelevant", similarity: 0.05 }];

    const db: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(lowSimilarityRow),
      query: {
        supportTickets: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1", title: "bug", description: null }),
        },
      },
    };

    const svc = new SupportAiService(
      db as never,
      makeLlm() as never,
      makeEmbeddings() as never,
      makeAiUsage() as never,
      makeOrgFeatures() as never,
    );

    const result = await svc.suggestKbArticles("org-1", 1);
    expect(result).toBeNull();
  });
});
