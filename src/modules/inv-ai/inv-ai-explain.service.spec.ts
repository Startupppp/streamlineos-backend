import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { InvAiExplainService } from "./inv-ai-explain.service";
import type { AiGatewayService } from "../ai/gateway/ai-gateway.service";

const MOCK_INSIGHT = {
  id: 1,
  orgId: "org-1",
  insightType: "stockout_risk",
  severity: "high",
  title: "Stockout risk: SKU-007",
  body: "Available qty (2) is below weekly demand (10).",
  status: "NEW" as const,
  sourceRefs: { variantId: 7, variantSku: "SKU-007", onHand: "5.00", committed: "3.00" },
  createdAt: new Date("2026-01-01"),
};

const MOCK_NARRATION = {
  explanation: "SKU-007 has critically low stock relative to weekly demand.",
  factors: [
    { label: "Available qty", value: "2", isFactual: true },
    { label: "Weekly demand", value: "10", isFactual: true },
    { label: "Action needed", value: "Reorder immediately", isFactual: false },
  ],
  suggestedActions: ["Create a purchase order for SKU-007", "Alert the procurement team"],
};

function buildService(db: object, gateway: Partial<AiGatewayService>) {
  return new InvAiExplainService(db as never, gateway as AiGatewayService);
}

describe("InvAiExplainService - explainInsight", () => {
  it("passes computed evidence to LLM and does not ask model to compute numbers", async () => {
    let capturedPrompt: { system: string; user: string } | undefined;

    const gateway = {
      invokeStructured: jest.fn().mockImplementation((opts: { prompt: { system: string; user: string } }) => {
        capturedPrompt = opts.prompt;
        return Promise.resolve({ ok: true, data: MOCK_NARRATION, model: "fast", latencyMs: 100, correlationId: "x", usage: {} });
      }),
    };

    const db = {
      query: {
        invAiInsights: {
          findFirst: jest.fn().mockResolvedValue(MOCK_INSIGHT),
        },
      },
    };

    const service = buildService(db, gateway);
    await service.explainInsight("org-1", "user-1", 1);

    expect(gateway.invokeStructured).toHaveBeenCalledTimes(1);
    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt!.system).toContain("MUST NOT compute");
    expect(capturedPrompt!.system).toContain("invent");
    expect(capturedPrompt!.user).toContain("variantId");
    expect(capturedPrompt!.user).toContain("SKU-007");
    expect(capturedPrompt!.user).toContain("source of truth");
  });

  it("charges credits via feature key inv.insight-explain", async () => {
    const gateway = {
      invokeStructured: jest.fn().mockResolvedValue({ ok: true, data: MOCK_NARRATION, model: "fast", latencyMs: 100, correlationId: "x", usage: {} }),
    };

    const db = {
      query: {
        invAiInsights: {
          findFirst: jest.fn().mockResolvedValue(MOCK_INSIGHT),
        },
      },
    };

    const service = buildService(db, gateway);
    await service.explainInsight("org-1", "user-1", 1);

    const callArgs = (gateway.invokeStructured as jest.Mock).mock.calls[0][0];
    expect(callArgs.feature).toBe("inv.insight-explain");
    expect(callArgs.charge).toBeDefined();
    expect(typeof callArgs.charge.credits).toBe("number");
    expect(callArgs.charge.credits).toBeGreaterThan(0);
  });

  it("returns structured narration with facts separated from suggestions", async () => {
    const gateway = {
      invokeStructured: jest.fn().mockResolvedValue({ ok: true, data: MOCK_NARRATION, model: "fast", latencyMs: 100, correlationId: "x", usage: {} }),
    };

    const db = {
      query: {
        invAiInsights: {
          findFirst: jest.fn().mockResolvedValue(MOCK_INSIGHT),
        },
      },
    };

    const service = buildService(db, gateway);
    const result = await service.explainInsight("org-1", "user-1", 1);

    expect(result.explanation).toBe(MOCK_NARRATION.explanation);
    expect(result.suggestedActions).toEqual(MOCK_NARRATION.suggestedActions);

    const factual = result.factors.filter((f) => f.isFactual);
    const nonFactual = result.factors.filter((f) => !f.isFactual);
    expect(factual.length).toBeGreaterThan(0);
    expect(nonFactual.length).toBeGreaterThan(0);

    expect(result.evidenceSnapshot).toMatchObject({
      insightId: MOCK_INSIGHT.id,
      insightType: MOCK_INSIGHT.insightType,
      severity: MOCK_INSIGHT.severity,
    });
  });

  it("throws NotFoundException if insight not found", async () => {
    const gateway = {
      invokeStructured: jest.fn(),
    };

    const db = {
      query: {
        invAiInsights: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
      },
    };

    const service = buildService(db, gateway);
    await expect(service.explainInsight("org-1", "user-1", 999)).rejects.toThrow(NotFoundException);
    expect(gateway.invokeStructured).not.toHaveBeenCalled();
  });

  it("throws ServiceUnavailableException when gateway returns not-ok", async () => {
    const gateway = {
      invokeStructured: jest.fn().mockResolvedValue({
        ok: false,
        kind: "provider_unavailable",
        message: "AI provider is temporarily unavailable",
        correlationId: "y",
      }),
    };

    const db = {
      query: {
        invAiInsights: {
          findFirst: jest.fn().mockResolvedValue(MOCK_INSIGHT),
        },
      },
    };

    const service = buildService(db, gateway);
    await expect(service.explainInsight("org-1", "user-1", 1)).rejects.toThrow(ServiceUnavailableException);
  });
});
