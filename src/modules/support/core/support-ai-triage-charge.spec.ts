import { NotFoundException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { SupportAiTriageService } from "./support-ai-triage.service";

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

function buildMockDb(ticket: Record<string, unknown> | null = { id: 42, orgId: "org1", title: "Test", description: "desc", category: null }) {
  return {
    query: {
      supportTickets: { findFirst: jest.fn().mockResolvedValue(ticket) },
      supportTicketMessages: { findMany: jest.fn().mockResolvedValue([]) },
      supportAiSuggestions: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 1 }]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
  };
}

function buildService(
  gatewayResult: ReturnType<typeof makeGatewayOk> | ReturnType<typeof makeGatewayFail>,
  dbOverride?: ReturnType<typeof buildMockDb>,
) {
  const db = dbOverride ?? buildMockDb();
  const mockGateway = { invokeStructured: jest.fn().mockResolvedValue(gatewayResult), invokeText: jest.fn() };
  const mockEmbeddings = { isConfigured: jest.fn().mockReturnValue(false) };
  const mockOrgFeatures = { getFlags: jest.fn().mockResolvedValue({ supportAi: true }) };
  const mockAiSettings = { getSettings: jest.fn().mockResolvedValue({ confidenceThreshold: 0.7 }) };
  const mockEmbHelper = { upsertAndSearchSimilar: jest.fn(), getDuplicateThreshold: jest.fn().mockReturnValue(0.85), getRootCauseThreshold: jest.fn().mockReturnValue(0.8) };
  const mockKbAccess = { getAccessibleSpaceIds: jest.fn().mockResolvedValue([]), getPrincipalIds: jest.fn() };

  const svc = new SupportAiTriageService(
    db as never,
    mockGateway as never,
    mockEmbeddings as never,
    mockOrgFeatures as never,
    mockAiSettings as never,
    mockEmbHelper as never,
    mockKbAccess as never,
  );
  return { svc, mockGateway };
}

describe("SupportAiTriageService.analyzeTicket — credit charging", () => {
  it("passes charge: true to the gateway so support.analysis credits are reserved", async () => {
    const { svc, mockGateway } = buildService(makeGatewayOk({
      summary: "Test", sentiment: "neutral", category: null, suggestedPriority: "LOW", isSpam: false, confidence: 0.8,
    }));

    await svc.analyzeTicket("org1", 42);

    expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
      expect.objectContaining({ charge: true, feature: "support.analysis" }),
    );
  });

  it("throws InsufficientAiCreditsException (402) when credits are exhausted", async () => {
    const { svc } = buildService(makeGatewayFail("quota_exceeded", "Insufficient AI credits"));

    await expect(svc.analyzeTicket("org1", 42)).rejects.toBeInstanceOf(InsufficientAiCreditsException);
  });

  it("returns null (no throw) when provider is temporarily unavailable", async () => {
    const { svc } = buildService(makeGatewayFail("provider_unavailable"));

    const result = await svc.analyzeTicket("org1", 42);
    expect(result).toBeNull();
  });

  it("throws NotFoundException when ticket is not found (cross-org or missing)", async () => {
    const { svc } = buildService(makeGatewayOk({ summary: "", sentiment: "neutral", category: null, suggestedPriority: "LOW", isSpam: false, confidence: 0 }), buildMockDb(null));

    await expect(svc.analyzeTicket("org1", 999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns null when supportAi feature flag is off", async () => {
    const db = buildMockDb();
    const mockGateway = { invokeStructured: jest.fn(), invokeText: jest.fn() };
    const mockEmbeddings = { isConfigured: jest.fn().mockReturnValue(false) };
    const mockOrgFeatures = { getFlags: jest.fn().mockResolvedValue({ supportAi: false }) };
    const mockAiSettings = { getSettings: jest.fn() };
    const mockEmbHelper = { upsertAndSearchSimilar: jest.fn(), getDuplicateThreshold: jest.fn(), getRootCauseThreshold: jest.fn() };
    const mockKbAccess = { getAccessibleSpaceIds: jest.fn(), getPrincipalIds: jest.fn() };

    const svc = new SupportAiTriageService(
      db as never, mockGateway as never, mockEmbeddings as never,
      mockOrgFeatures as never, mockAiSettings as never, mockEmbHelper as never, mockKbAccess as never,
    );

    const result = await svc.analyzeTicket("org1", 42);
    expect(result).toBeNull();
    expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
  });
});
