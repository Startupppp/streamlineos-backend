import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { KbRagService } from "./kb-rag.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { EmbeddingsService } from "../providers/embeddings.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";

const makeGatewayOk = (text: string) => ({
  ok: true as const,
  data: text,
  model: "gpt-4o-mini",
  latencyMs: 10,
  correlationId: "corr-1",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

const makeGatewayFail = (
  kind:
    | "quota_exceeded"
    | "provider_unavailable"
    | "not_configured"
    | "invalid_output",
  message = "error",
) => ({
  ok: false as const,
  kind,
  message,
  correlationId: "corr-err",
});

const chunkRow = {
  id: 1,
  articleId: 10,
  attachmentId: null,
  source: "body",
  content: "Here is some helpful content.",
  title: "Getting Started",
  slug: "getting-started",
  attachmentName: null,
  similarity: 0.85,
};

const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([chunkRow]),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  catch: jest.fn(),
};

const mockEmbeddings = {
  isConfigured: jest.fn().mockReturnValue(true),
  embedQuery: jest.fn().mockResolvedValue(new Array(1536).fill(0.01)),
  toVectorLiteral: jest.fn((vec: number[]) => `[${vec.join(",")}]`),
};

const mockGateway = {
  invokeText: jest.fn(),
};

const ORG_ID = "org1";
const QUESTION = "How do I reset?";

describe("KbRagService", () => {
  let service: KbRagService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.limit.mockResolvedValue([chunkRow]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KbRagService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: EmbeddingsService, useValue: mockEmbeddings },
        { provide: AiGatewayService, useValue: mockGateway },
      ],
    }).compile();
    service = module.get(KbRagService);
  });

  describe("answerQuestion", () => {
    it("returns no-context answer when org has no published public articles", async () => {
      mockDb.limit.mockResolvedValueOnce([]).mockResolvedValue([chunkRow]);

      const result = await service.answerQuestion({
        orgId: ORG_ID,
        question: QUESTION,
      });

      expect(result.hasContext).toBe(false);
      expect(mockGateway.invokeText).not.toHaveBeenCalled();
    });

    it("charges via gateway when org has public articles and chunks are found", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: 99 }])
        .mockResolvedValue([chunkRow]);
      mockGateway.invokeText.mockResolvedValueOnce(
        makeGatewayOk("Sure, here is how."),
      );

      const result = await service.answerQuestion({
        orgId: ORG_ID,
        question: QUESTION,
      });

      expect(result.hasContext).toBe(true);
      const [call] = mockGateway.invokeText.mock.calls;
      expect(call[0].charge).toBe(true);
      expect(call[0].actor).toEqual({ orgId: ORG_ID, userId: null });
    });

    it("maps quota_exceeded to BadRequestException", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: 99 }])
        .mockResolvedValue([chunkRow]);
      mockGateway.invokeText.mockResolvedValueOnce(
        makeGatewayFail("quota_exceeded", "Insufficient AI credits"),
      );

      await expect(
        service.answerQuestion({ orgId: ORG_ID, question: QUESTION }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws ServiceUnavailableException on provider_unavailable", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: 99 }])
        .mockResolvedValue([chunkRow]);
      mockGateway.invokeText.mockResolvedValueOnce(
        makeGatewayFail("provider_unavailable"),
      );

      await expect(
        service.answerQuestion({ orgId: ORG_ID, question: QUESTION }),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
