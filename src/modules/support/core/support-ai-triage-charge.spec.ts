import { NotFoundException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { SupportAiTriageAnalysisService } from "./support-ai-triage-analysis.service";

const makeGatewayOk = <T>(data: T) => ({
  ok: true as const,
  data,
  model: "gpt-4o-mini",
  latencyMs: 10,
  correlationId: "corr-1",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

const makeGatewayFail = (kind: "quota_exceeded" | "provider_unavailable" | "not_configured" | "invalid_output", message = "error") => ({
  ok: false as const,
  kind,
  message,
  correlationId: "corr-err",
});

const defaultTicket = { id: 42, orgId: "org1", title: "Test", description: "desc", category: null };

function buildMockDb(ticket: Record<string, unknown> | null = defaultTicket) {
  return {
    query: {
      supportTicketMessages: { findMany: jest.fn().mockResolvedValue([]) },
    },
  };
}

function buildMockData(ticket: Record<string, unknown> | null = defaultTicket) {
  return {
    isAvailable: jest.fn().mockResolvedValue(true),
    getTicketOrThrow: ticket
      ? jest.fn().mockResolvedValue(ticket)
      : jest.fn().mockRejectedValue(new NotFoundException("Ticket not found")),
    replacePendingSuggestions: jest.fn().mockResolvedValue(undefined),
    insertSuggestion: jest.fn().mockResolvedValue({ id: 1 }),
  };
}

function buildService(
  gatewayResult: ReturnType<typeof makeGatewayOk> | ReturnType<typeof makeGatewayFail>,
  dbOverride?: ReturnType<typeof buildMockDb>,
  dataOverride?: ReturnType<typeof buildMockData>,
) {
  const db = dbOverride ?? buildMockDb();
  const mockData = dataOverride ?? buildMockData();
  const mockGateway = {
    invokeStructured: jest.fn().mockResolvedValue(gatewayResult),
    invokeText: jest.fn(),
    isEmbeddingConfigured: jest.fn().mockReturnValue(false),
  };
  const mockOrgFeatures = { getFlags: jest.fn().mockResolvedValue({ supportAi: true }) };
  const mockEmbHelper = { upsertAndSearchSimilar: jest.fn(), getDuplicateThreshold: jest.fn().mockReturnValue(0.85), getRootCauseThreshold: jest.fn().mockReturnValue(0.8) };

  const svc = new SupportAiTriageAnalysisService(
    db as never,
    mockData as never,
    mockGateway as never,
    mockOrgFeatures as never,
    mockEmbHelper as never,
  );
  return { svc, mockGateway };
}

describe("SupportAiTriageAnalysisService.analyzeTicket — credit charging", () => {
  it("passes charge: true to the gateway so support.analysis credits are reserved", async () => {
    const { svc, mockGateway } = buildService(makeGatewayOk({
      summary: "Test", sentiment: "neutral", category: null, suggestedPriority: "LOW", isSpam: false, confidence: 0.8,
    }));

    await svc.analyzeTicket("org1", 42, "user-abc");

    expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
      expect.objectContaining({ charge: true, feature: "support.analysis" }),
    );
  });

  it("passes the caller userId (not null) to the gateway actor", async () => {
    const { svc, mockGateway } = buildService(makeGatewayOk({
      summary: "Test", sentiment: "neutral", category: null, suggestedPriority: "LOW", isSpam: false, confidence: 0.8,
    }));

    await svc.analyzeTicket("org1", 42, "user-from-token");

    expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { orgId: "org1", userId: "user-from-token" } }),
    );
  });

  it("throws InsufficientAiCreditsException (402) when credits are exhausted", async () => {
    const { svc } = buildService(makeGatewayFail("quota_exceeded", "Insufficient AI credits"));

    await expect(svc.analyzeTicket("org1", 42, "user-abc")).rejects.toBeInstanceOf(InsufficientAiCreditsException);
  });

  it("returns null (no throw) when provider is temporarily unavailable", async () => {
    const { svc } = buildService(makeGatewayFail("provider_unavailable"));

    const result = await svc.analyzeTicket("org1", 42, "user-abc");
    expect(result).toBeNull();
  });

  it("throws NotFoundException when ticket is not found (cross-org or missing)", async () => {
    const { svc } = buildService(
      makeGatewayOk({ summary: "", sentiment: "neutral", category: null, suggestedPriority: "LOW", isSpam: false, confidence: 0 }),
      buildMockDb(null),
      buildMockData(null),
    );

    await expect(svc.analyzeTicket("org1", 999, "user-abc")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns null when supportAi feature flag is off", async () => {
    const db = buildMockDb();
    const mockGateway = {
      invokeStructured: jest.fn(),
      invokeText: jest.fn(),
      isEmbeddingConfigured: jest.fn().mockReturnValue(false),
    };
    const mockOrgFeatures = { getFlags: jest.fn().mockResolvedValue({ supportAi: false }) };
    const mockEmbHelper = { upsertAndSearchSimilar: jest.fn(), getDuplicateThreshold: jest.fn(), getRootCauseThreshold: jest.fn() };
    const mockData = {
      isAvailable: jest.fn().mockResolvedValue(false),
      getTicketOrThrow: jest.fn(),
      replacePendingSuggestions: jest.fn(),
      insertSuggestion: jest.fn(),
    };

    const svc = new SupportAiTriageAnalysisService(
      db as never, mockData as never, mockGateway as never,
      mockOrgFeatures as never, mockEmbHelper as never,
    );

    const result = await svc.analyzeTicket("org1", 42, "user-abc");
    expect(result).toBeNull();
    expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
  });
});
