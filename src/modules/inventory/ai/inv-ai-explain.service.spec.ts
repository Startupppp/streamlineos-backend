import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { InvAiExplainService } from "./inv-ai-explain.service";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { VendorScorecardService } from "../vendors/vendor-scorecard.service";

const MOCK_INSIGHT = {
  id: 1,
  orgId: "org-1",
  insightType: "stockout_risk",
  severity: "high",
  title: "Stockout risk: SKU-007",
  body: "Available qty (2) is below weekly demand (10).",
  status: "NEW" as const,
  sourceRefs: {
    variantId: 7,
    variantSku: "SKU-007",
    onHand: "5.00",
    committed: "3.00",
  },
  createdAt: new Date("2026-01-01"),
};

/**
 * INV-102 shape. The model returns a status, bounded fields, and actions as
 * enum members with evidence it was actually given -- `suggestedActions`, a
 * list of sentences the model wrote, is gone.
 */
const MOCK_NARRATION = {
  status: "ok" as const,
  explanation: "SKU-007 has critically low stock relative to weekly demand.",
  factors: [
    { label: "Available qty", value: "2", isFactual: true },
    { label: "Weekly demand", value: "10", isFactual: true },
    { label: "Action needed", value: "Reorder immediately", isFactual: false },
  ],
  recommendations: [
    {
      action: "draft_purchase_order" as const,
      rationale: "Cover is below the weekly demand figure above.",
      evidence: [{ kind: "product_variant" as const, id: 7 }],
    },
    {
      action: "open_stock_movements" as const,
      rationale: "The recent issues explain the drop.",
      evidence: [{ kind: "product_variant" as const, id: 7 }],
    },
  ],
};

/**
 * F4. The reorder proposal left this service for
 * `proposals/inv-ai-proposal.service.ts`, taking the confirmation service, the
 * replenishment service and the access service with it — so this builder no
 * longer has anything to hand them. The two placeholder parameters are kept in
 * position because every remaining call site passes `undefined` for them, and
 * renumbering forty call sites to delete two holes is churn that could only
 * introduce a mistake.
 */
function buildService(
  db: object,
  gateway: Partial<AiGatewayService>,
  _confirmation?: undefined,
  _replenishment?: undefined,
  scorecards?: Partial<VendorScorecardService>,
  insights?: { getOpsBrief?: unknown },
) {
  return new InvAiExplainService(
    db as never,
    gateway as AiGatewayService,
    (scorecards ?? {}) as VendorScorecardService,
    (insights ?? {}) as never,
  );
}

describe("InvAiExplainService - explainInsight", () => {
  it("passes computed evidence to LLM and does not ask model to compute numbers", async () => {
    let capturedPrompt: { system: string; user: string } | undefined;

    const gateway = {
      invokeStructured: jest
        .fn()
        .mockImplementation(
          (opts: { prompt: { system: string; user: string } }) => {
            capturedPrompt = opts.prompt;
            return Promise.resolve({
              ok: true,
              data: MOCK_NARRATION,
              model: "fast",
              latencyMs: 100,
              correlationId: "x",
              usage: {},
            });
          },
        ),
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
      invokeStructured: jest.fn().mockResolvedValue({
        ok: true,
        data: MOCK_NARRATION,
        model: "fast",
        latencyMs: 100,
        correlationId: "x",
        usage: {},
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

    const callArgs = (gateway.invokeStructured as jest.Mock).mock.calls[0][0];
    expect(callArgs.feature).toBe("inv.insight-explain");
    expect(callArgs.charge).toBe(true);
  });

  it("returns structured narration with facts separated from suggestions", async () => {
    const gateway = {
      invokeStructured: jest.fn().mockResolvedValue({
        ok: true,
        data: MOCK_NARRATION,
        model: "fast",
        latencyMs: 100,
        correlationId: "x",
        usage: {},
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
    const result = await service.explainInsight("org-1", "user-1", 1);

    expect(result.explanation).toBe(MOCK_NARRATION.explanation);
    // Actions are resolved server-side now: the model named two enum members
    // and the server supplied the label, route and permission for each.
    expect(result.actions.map((a) => a.action)).toEqual([
      "draft_purchase_order",
      "open_stock_movements",
    ]);
    expect(result.actions.every((a) => a.permission.startsWith("inventory:"))).toBe(
      true,
    );
    expect(result.provenance).toEqual({
      contractVersion: 1,
      promptKey: "inv.insight-explain",
      promptVersion: 1,
      // Both come from the gateway result rather than being defaulted here,
      // which is the point: a stored narrative can be traced to the call that
      // produced it.
      model: "fast",
      correlationId: "x",
    });

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
    await expect(
      service.explainInsight("org-1", "user-1", 999),
    ).rejects.toThrow(NotFoundException);
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
    await expect(service.explainInsight("org-1", "user-1", 1)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

const MOCK_DELAY_INSIGHT_V1 = {
  id: 10,
  title: "Delay: ACME Corp",
  body: "3 open POs overdue",
  severity: "high",
  sourceRefs: { vendorId: 1, vendorName: "ACME Corp" },
};

const MOCK_DELAY_INSIGHT_V2A = {
  id: 20,
  title: "Delay: BestVend",
  body: "2 open POs overdue",
  severity: "medium",
  sourceRefs: { vendorId: 2, vendorName: "BestVend" },
};

const MOCK_DELAY_INSIGHT_V2B = {
  id: 21,
  title: "Delay: BestVend repeat",
  body: "1 more PO late",
  severity: "low",
  sourceRefs: { vendorId: 2, vendorName: "BestVend" },
};

/**
 * C4. Every rate arrives beside the sample it was computed from, so the
 * briefing can say "72% over 25 orders" rather than a bare percentage.
 */
const MOCK_VENDOR_SCORECARD = {
  vendorId: 1,
  leadTime: {
    observations: 9,
    meanDays: 9,
    stdDevDays: 2,
    p50Days: 8,
    p90Days: 14,
    reliable: true,
  },
  onTime: {
    percent: "72.00",
    numerator: "18",
    denominator: "25",
    sampleSize: 25,
    sufficient: true,
  },
  lineFill: {
    percent: "87.00",
    numerator: "87",
    denominator: "100",
    sampleSize: 100,
    sufficient: true,
  },
  unitFill: {
    percent: "87.00",
    numerator: "870.0000",
    denominator: "1000.0000",
    sampleSize: 100,
    sufficient: true,
  },
  returns: {
    percent: "1.00",
    numerator: "10.0000",
    denominator: "1000.0000",
    sampleSize: 2,
    sufficient: false,
  },
  rejection: {
    percent: "2.00",
    numerator: "2",
    denominator: "100",
    sampleSize: 100,
    sufficient: true,
  },
  discrepancy: {
    percent: "3.00",
    numerator: "3",
    denominator: "100",
    sampleSize: 100,
    sufficient: true,
  },
  openPoCount: 3,
  spend: { amount: "12000.0000", currency: "INR", excludedCurrencies: [] },
  notes: [],
};

const scorecardStub = (...vendorIds: number[]) => ({
  scorecardsFor: jest
    .fn()
    .mockResolvedValue(
      new Map(
        vendorIds.map((id) => [id, { ...MOCK_VENDOR_SCORECARD, vendorId: id }]),
      ),
    ),
});

describe("InvAiExplainService - getSupplierDelayBriefing", () => {
  it("should group vendor_delay insights by vendor and return one entry per vendor", async () => {
    const db = {
      query: {
        invAiInsights: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              MOCK_DELAY_INSIGHT_V1,
              MOCK_DELAY_INSIGHT_V2A,
              MOCK_DELAY_INSIGHT_V2B,
            ]),
          findFirst: jest.fn(),
        },
      },
    };
    const gateway = {
      invokeText: jest
        .fn()
        .mockResolvedValue({ ok: true, data: "Vendor ACME has shown delays." }),
    };
    const vendors = scorecardStub(1, 2);

    const service = buildService(db, gateway, undefined, undefined, vendors);
    const result = await service.getSupplierDelayBriefing("org-1", "user-1");

    expect(result.vendors).toHaveLength(2);
    const vendorIds = result.vendors.map((v) => v.vendorId).sort();
    expect(vendorIds).toEqual([1, 2]);
  });

  it("should return AI-generated narration text, not computed numbers", async () => {
    const aiNarration =
      "Vendor ACME has shown persistent delays with an on-time rate of 72%.";
    const db = {
      query: {
        invAiInsights: {
          findMany: jest.fn().mockResolvedValue([MOCK_DELAY_INSIGHT_V1]),
          findFirst: jest.fn(),
        },
      },
    };
    const gateway = {
      invokeText: jest.fn().mockResolvedValue({ ok: true, data: aiNarration }),
    };
    const vendors = scorecardStub(1, 2);

    const service = buildService(db, gateway, undefined, undefined, vendors);
    const result = await service.getSupplierDelayBriefing("org-1", "user-1");

    expect(result.narration).toBe(aiNarration);
    expect(result.vendors[0]!.performance).toEqual({
      ...MOCK_VENDOR_SCORECARD,
      vendorId: result.vendors[0]!.vendorId,
    });
  });

  it("should have performance figures from the scorecard service, not from invokeText", async () => {
    const db = {
      query: {
        invAiInsights: {
          findMany: jest.fn().mockResolvedValue([MOCK_DELAY_INSIGHT_V1]),
          findFirst: jest.fn(),
        },
      },
    };
    const invokeText = jest.fn().mockResolvedValue({
      ok: true,
      data: "Some narrative with no computed numbers.",
    });
    const gateway = { invokeText };
    const vendors = scorecardStub(1, 2);

    const service = buildService(db, gateway, undefined, undefined, vendors);
    const result = await service.getSupplierDelayBriefing("org-1", "user-1");

    expect(result.vendors[0]!.performance.onTime.percent).toBe("72.00");
    expect(result.vendors[0]!.performance.onTime.sampleSize).toBe(25);
    expect(result.vendors[0]!.performance.leadTime.p90Days).toBe(14);
    const invokeTextReturn = (
      invokeText.mock.results[0] as {
        value: Promise<{ ok: boolean; data: string }>;
      }
    ).value;
    await expect(invokeTextReturn).resolves.toMatchObject({
      data: expect.stringContaining("narrative"),
    });
  });

  it("should charge credits via feature key inv.supplier-delay-briefing", async () => {
    const db = {
      query: {
        invAiInsights: {
          findMany: jest.fn().mockResolvedValue([MOCK_DELAY_INSIGHT_V1]),
          findFirst: jest.fn(),
        },
      },
    };
    const gateway = {
      invokeText: jest.fn().mockResolvedValue({ ok: true, data: "Narrative." }),
    };
    const vendors = scorecardStub(1, 2);

    const service = buildService(db, gateway, undefined, undefined, vendors);
    await service.getSupplierDelayBriefing("org-1", "user-1");

    const callArgs = (gateway.invokeText as jest.Mock).mock.calls[0][0];
    expect(callArgs.feature).toBe("inv.supplier-delay-briefing");
    expect(callArgs.charge).toBe(true);
  });

  it("should throw ServiceUnavailableException when AI gateway invokeText returns not-ok", async () => {
    const db = {
      query: {
        invAiInsights: {
          findMany: jest.fn().mockResolvedValue([MOCK_DELAY_INSIGHT_V1]),
          findFirst: jest.fn(),
        },
      },
    };
    const gateway = {
      invokeText: jest.fn().mockResolvedValue({
        ok: false,
        kind: "provider_unavailable",
        message: "Gateway error",
        correlationId: "z",
      }),
    };
    const vendors = scorecardStub(1, 2);

    const service = buildService(db, gateway, undefined, undefined, vendors);
    await expect(
      service.getSupplierDelayBriefing("org-1", "user-1"),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it("should return static narration without calling AI when there are no delay insights", async () => {
    const db = {
      query: {
        invAiInsights: {
          findMany: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn(),
        },
      },
    };
    const invokeText = jest.fn();
    const gateway = { invokeText };
    const vendors = scorecardStub();

    const service = buildService(db, gateway, undefined, undefined, vendors);
    const result = await service.getSupplierDelayBriefing("org-1", "user-1");

    expect(invokeText).not.toHaveBeenCalled();
    expect(result.vendors).toHaveLength(0);
    expect(result.narration).toBe("No active supplier delay alerts detected.");
  });

  it("should filter insights by vendorId when vendorId is provided", async () => {
    const db = {
      query: {
        invAiInsights: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              MOCK_DELAY_INSIGHT_V1,
              MOCK_DELAY_INSIGHT_V2A,
              MOCK_DELAY_INSIGHT_V2B,
            ]),
          findFirst: jest.fn(),
        },
      },
    };
    const gateway = {
      invokeText: jest
        .fn()
        .mockResolvedValue({ ok: true, data: "Only ACME narrative." }),
    };
    const vendors = scorecardStub(1, 2);

    const service = buildService(db, gateway, undefined, undefined, vendors);
    const result = await service.getSupplierDelayBriefing("org-1", "user-1", 1);

    expect(result.vendors).toHaveLength(1);
    expect(result.vendors[0]!.vendorId).toBe(1);
    expect(result.vendors[0]!.vendorName).toBe("ACME Corp");
  });
});
