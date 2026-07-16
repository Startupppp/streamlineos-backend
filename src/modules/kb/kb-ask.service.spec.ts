import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { KbAskService } from "./kb-ask.service";
import { AiGatewayService } from "../ai/gateway/ai-gateway.service";
import { KbEventsService } from "./kb-events.service";
import { KbSearchService } from "./kb-search.service";

const makeGatewayOk = (text: string) => ({
  ok: true as const,
  data: text,
  model: "gpt-4o-mini",
  latencyMs: 12,
  correlationId: "corr-1",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

const makeGatewayFail = (kind: "quota_exceeded" | "provider_unavailable" | "not_configured" | "invalid_output", message = "error") => ({
  ok: false as const,
  kind,
  message,
  correlationId: "corr-err",
});

const mockGateway = {
  invokeText: jest.fn(),
};

const mockEvents = {
  record: jest.fn().mockResolvedValue(undefined),
};

const articleResult = { kind: "article" as const, id: 1, title: "Getting started", slug: "getting-started", spaceId: 1, contentText: "Some content" };

const mockSearch = {
  retrieveTopArticles: jest.fn().mockResolvedValue([articleResult]),
  retrieveTopSources: jest.fn().mockResolvedValue([]),
  retrieveAttachmentSnippets: jest.fn().mockResolvedValue(null),
};

const user = { orgId: "org1", userId: "user1" };
const input = { question: "How do I reset my password?" };

describe("KbAskService", () => {
  let service: KbAskService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSearch.retrieveTopArticles.mockResolvedValue([articleResult]);
    mockSearch.retrieveTopSources.mockResolvedValue([]);
    mockSearch.retrieveAttachmentSnippets.mockResolvedValue(null);
    mockEvents.record.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KbAskService,
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: KbEventsService, useValue: mockEvents },
        { provide: KbSearchService, useValue: mockSearch },
      ],
    }).compile();
    service = module.get(KbAskService);
  });

  it("returns no-context answer when retrieval finds nothing", async () => {
    mockSearch.retrieveTopArticles.mockResolvedValueOnce([]);
    mockSearch.retrieveTopSources.mockResolvedValueOnce([]);

    const result = await service.ask(user, input);

    expect(result.hasContext).toBe(false);
    expect(result.citations).toHaveLength(0);
    expect(mockGateway.invokeText).not.toHaveBeenCalled();
    expect(mockEvents.record).toHaveBeenCalled();
  });

  it("charges org wallet via gateway (no KbCreditsService) and returns answer", async () => {
    mockGateway.invokeText.mockResolvedValueOnce(makeGatewayOk("Here is how to reset your password."));

    const result = await service.ask(user, input);

    expect(result.hasContext).toBe(true);
    expect(result.answer).toBe("Here is how to reset your password.");
    expect(result.citations).toHaveLength(1);

    const [call] = mockGateway.invokeText.mock.calls;
    expect(call[0].feature).toBe("kb.ask");
    expect(call[0].tier).toBe("fast");
    expect(call[0].maxTokens).toBe(1024);
    expect(call[0].charge).toBeDefined();
    expect(call[0].charge.credits).toBe(1);
    expect(call[0].actor).toEqual({ orgId: "org1", userId: "user1" });
  });

  it("throws BadRequestException on quota_exceeded", async () => {
    mockGateway.invokeText.mockResolvedValueOnce(makeGatewayFail("quota_exceeded", "Insufficient AI credits"));
    await expect(service.ask(user, input)).rejects.toThrow(BadRequestException);
  });

  it("throws ServiceUnavailableException on provider_unavailable", async () => {
    mockGateway.invokeText.mockResolvedValueOnce(makeGatewayFail("provider_unavailable"));
    await expect(service.ask(user, input)).rejects.toThrow(ServiceUnavailableException);
  });

  it("records ai_answer event after a successful response", async () => {
    mockGateway.invokeText.mockResolvedValueOnce(makeGatewayOk("Reset via the login page."));

    await service.ask(user, input);

    expect(mockEvents.record).toHaveBeenCalledWith("org1", "ai_answer", expect.objectContaining({ actorId: "user1" }));
  });
});
