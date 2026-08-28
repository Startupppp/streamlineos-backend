import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { InvAiExplainService, hashReorderEvidence } from "./inv-ai-explain.service";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { AiConfirmationService } from "../../ai/confirmation/ai-confirmation.service";
import type { InvReplenishmentService } from "../replenishment/inv-replenishment.service";
import type { InvVendorsService } from "../vendors/inv-vendors.service";

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

/** The gateway hands back provenance beside the payload; the service records it. */
const MOCK_GATEWAY_META = {
  model: "test-model",
  latencyMs: 12,
  correlationId: "corr-1",
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
};

function buildService(
  db: object,
  gateway: Partial<AiGatewayService>,
  confirmation?: Partial<AiConfirmationService>,
  replenishment?: Partial<InvReplenishmentService>,
  vendors?: Partial<InvVendorsService>,
) {
  return new InvAiExplainService(
    db as never,
    gateway as AiGatewayService,
    (confirmation ?? {}) as AiConfirmationService,
    (replenishment ?? {}) as InvReplenishmentService,
    (vendors ?? {}) as InvVendorsService,
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

const MOCK_SUGGESTION = {
  productVariantId: 77,
  variantSku: "SKU-077",
  variantName: "Widget Blue",
  productName: "Widget",
  ruleId: 11,
  warehouseId: 5,
  warehouseName: "Main WH",
  currentOnHand: 3,
  forecasted: 1,
  suggestedQty: 42,
  vendorId: 9,
  leadTimeDays: 7,
  expectedDate: "2026-08-01",
  reason: "Forecasted qty (1) below min (10)",
};

const MOCK_EXPLAIN_RESPONSE = {
  status: "ok" as const,
  explanation: "Reorder is necessary due to low forecasted stock.",
  factors: [
    { label: "Current on-hand", value: "3", isFactual: true },
    { label: "Suggested order qty", value: "42", isFactual: true },
    { label: "Consider safety stock", value: "10%", isFactual: false },
  ],
  recommendations: [
    {
      action: "draft_purchase_order" as const,
      rationale: "Forecast exceeds cover before the lead time elapses.",
      evidence: [{ kind: "product_variant" as const, id: 77 }],
    },
  ],
};

const MOCK_PROPOSAL = {
  proposalId: 101,
  token: "101.9999999999.abc123",
  expiresAt: new Date(Date.now() + 120_000),
};

function buildReorderDb() {
  return {
    query: {
      invAiInsights: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    },
  };
}

describe("InvAiExplainService - getReorderProposal", () => {
  it("should embed suggestedQty from deterministic engine in the AI user prompt", async () => {
    let capturedUserPrompt = "";

    const gateway = {
      invokeStructured: jest
        .fn()
        .mockImplementation((opts: { prompt: { user: string } }) => {
          capturedUserPrompt = opts.prompt.user;
          return Promise.resolve({ ok: true, data: MOCK_EXPLAIN_RESPONSE, ...MOCK_GATEWAY_META });
        }),
    };
    const confirmation = {
      propose: jest.fn().mockResolvedValue(MOCK_PROPOSAL),
    };
    const replenishment = {
      getSuggestionForVariant: jest.fn().mockResolvedValue(MOCK_SUGGESTION),
    };

    const service = buildService(
      buildReorderDb(),
      gateway,
      confirmation,
      replenishment,
    );
    const result = await service.getReorderProposal("org-1", "user-1", 77);

    expect(capturedUserPrompt).toContain("42");
    expect(result.evidence["suggestedOrderQty"]).toBe(42);
  });

  it("should include AI restraint instruction in the system prompt", async () => {
    let capturedSystemPrompt = "";

    const gateway = {
      invokeStructured: jest
        .fn()
        .mockImplementation((opts: { prompt: { system: string } }) => {
          capturedSystemPrompt = opts.prompt.system;
          return Promise.resolve({ ok: true, data: MOCK_EXPLAIN_RESPONSE, ...MOCK_GATEWAY_META });
        }),
    };
    const confirmation = {
      propose: jest.fn().mockResolvedValue(MOCK_PROPOSAL),
    };
    const replenishment = {
      getSuggestionForVariant: jest.fn().mockResolvedValue(MOCK_SUGGESTION),
    };

    const service = buildService(
      buildReorderDb(),
      gateway,
      confirmation,
      replenishment,
    );
    await service.getReorderProposal("org-1", "user-1", 77);

    expect(capturedSystemPrompt.toLowerCase()).toMatch(
      /must not compute|must not derive|must not invent/i,
    );
  });

  it("should charge credits via feature key inv.reorder-explain", async () => {
    const gateway = {
      invokeStructured: jest
        .fn()
        .mockResolvedValue({ ok: true, data: MOCK_EXPLAIN_RESPONSE, ...MOCK_GATEWAY_META }),
    };
    const confirmation = {
      propose: jest.fn().mockResolvedValue(MOCK_PROPOSAL),
    };
    const replenishment = {
      getSuggestionForVariant: jest.fn().mockResolvedValue(MOCK_SUGGESTION),
    };

    const service = buildService(
      buildReorderDb(),
      gateway,
      confirmation,
      replenishment,
    );
    await service.getReorderProposal("org-1", "user-1", 77);

    const callArgs = (gateway.invokeStructured as jest.Mock).mock.calls[0][0];
    expect(callArgs.feature).toBe("inv.reorder-explain");
    expect(callArgs.charge).toBe(true);
  });

  it("should call AiConfirmationService.propose with action inventory:create-draft-po, not generatePo", async () => {
    const gateway = {
      invokeStructured: jest
        .fn()
        .mockResolvedValue({ ok: true, data: MOCK_EXPLAIN_RESPONSE, ...MOCK_GATEWAY_META }),
    };
    const generatePo = jest.fn();
    const confirmation = {
      propose: jest.fn().mockResolvedValue(MOCK_PROPOSAL),
    };
    const replenishment = {
      getSuggestionForVariant: jest.fn().mockResolvedValue(MOCK_SUGGESTION),
      generatePo,
    };

    const service = buildService(
      buildReorderDb(),
      gateway,
      confirmation,
      replenishment,
    );
    await service.getReorderProposal("org-1", "user-1", 77);

    expect(confirmation.propose).toHaveBeenCalledTimes(1);
    const proposeArg = (confirmation.propose as jest.Mock).mock.calls[0][0];
    expect(proposeArg.action).toBe("inventory:create-draft-po");
    expect(generatePo).not.toHaveBeenCalled();
  });

  it("should return proposal from AiConfirmationService.propose in the result", async () => {
    const gateway = {
      invokeStructured: jest
        .fn()
        .mockResolvedValue({ ok: true, data: MOCK_EXPLAIN_RESPONSE, ...MOCK_GATEWAY_META }),
    };
    const confirmation = {
      propose: jest.fn().mockResolvedValue(MOCK_PROPOSAL),
    };
    const replenishment = {
      getSuggestionForVariant: jest.fn().mockResolvedValue(MOCK_SUGGESTION),
    };

    const service = buildService(
      buildReorderDb(),
      gateway,
      confirmation,
      replenishment,
    );
    const result = await service.getReorderProposal("org-1", "user-1", 77);

    expect(result.proposal.proposalId).toBe(101);
    expect(result.proposal.token).toBe("101.9999999999.abc123");
  });

  it("should throw NotFoundException when no suggestion matches the variantId", async () => {
    const gateway = { invokeStructured: jest.fn() };
    const confirmation = { propose: jest.fn() };
    const replenishment = {
      getSuggestionForVariant: jest.fn().mockResolvedValue(null),
    };

    const service = buildService(
      buildReorderDb(),
      gateway,
      confirmation,
      replenishment,
    );
    await expect(
      service.getReorderProposal("org-1", "user-1", 9999),
    ).rejects.toThrow(NotFoundException);
    expect(gateway.invokeStructured).not.toHaveBeenCalled();
  });

  it("should throw ServiceUnavailableException when AI gateway returns not-ok", async () => {
    const gateway = {
      invokeStructured: jest.fn().mockResolvedValue({
        ok: false,
        kind: "provider_unavailable",
        message: "Gateway error",
        correlationId: "z",
      }),
    };
    const confirmation = { propose: jest.fn() };
    const replenishment = {
      getSuggestionForVariant: jest.fn().mockResolvedValue(MOCK_SUGGESTION),
    };

    const service = buildService(
      buildReorderDb(),
      gateway,
      confirmation,
      replenishment,
    );
    await expect(
      service.getReorderProposal("org-1", "user-1", 77),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(confirmation.propose).not.toHaveBeenCalled();
  });

  it("should preserve isFactual values for both factual and suggestion factors", async () => {
    const explainWithBothFactTypes = {
      status: "ok" as const,
      explanation: "Reorder necessary.",
      factors: [
        { label: "Stock level", value: "42", isFactual: true },
        { label: "Consider safety stock", value: "10%", isFactual: false },
      ],
      recommendations: [
        {
          action: "draft_purchase_order" as const,
          rationale: "Cover is short.",
          evidence: [{ kind: "product_variant" as const, id: 77 }],
        },
      ],
    };

    const gateway = {
      invokeStructured: jest
        .fn()
        .mockResolvedValue({ ok: true, data: explainWithBothFactTypes, ...MOCK_GATEWAY_META }),
    };
    const confirmation = {
      propose: jest.fn().mockResolvedValue(MOCK_PROPOSAL),
    };
    const replenishment = {
      getSuggestionForVariant: jest.fn().mockResolvedValue(MOCK_SUGGESTION),
    };

    const service = buildService(
      buildReorderDb(),
      gateway,
      confirmation,
      replenishment,
    );
    const result = await service.getReorderProposal("org-1", "user-1", 77);

    const factual = result.explanation.factors.filter((f) => f.isFactual);
    const nonFactual = result.explanation.factors.filter((f) => !f.isFactual);
    expect(factual).toHaveLength(1);
    expect(factual[0]!.label).toBe("Stock level");
    expect(nonFactual).toHaveLength(1);
    expect(nonFactual[0]!.label).toBe("Consider safety stock");
  });
});

describe("InvAiExplainService - confirmReorderProposal", () => {
  it("should call generatePo with vendor, warehouse, variant, and qty from the confirmed payload", async () => {
    const confirmedPayload = {
      proposalId: 101,
      action: "inventory:create-draft-po",
      payload: {
        suggestion: {
          productVariantId: 77,
          suggestedQty: 10,
          vendorId: 9,
          warehouseId: 5,
        },
      },
    };

    const gateway = { invokeStructured: jest.fn() };
    const generatePo = jest.fn().mockResolvedValue({ id: "po-1" });
    const confirmation = {
      confirm: jest.fn().mockResolvedValue(confirmedPayload),
      markExecuted: jest.fn().mockResolvedValue(undefined),
    };
    const replenishment = { generatePo };

    const service = buildService(
      buildReorderDb(),
      gateway,
      confirmation,
      replenishment,
    );
    await service.confirmReorderProposal(
      "org-1",
      "user-1",
      101,
      "101.9999999999.abc123",
    );

    expect(generatePo).toHaveBeenCalledTimes(1);
    const poArgs = generatePo.mock.calls[0];
    expect(poArgs[0]).toBe("org-1");
    expect(poArgs[1]).toBe("user-1");
    const body = poArgs[2];
    expect(body.vendorId).toBe(9);
    expect(body.warehouseId).toBe(5);
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].productVariantId).toBe(77);
    expect(body.suggestions[0].suggestedQty).toBe(10);
  });

  it("should call AiConfirmationService.markExecuted with proposalId and poId after generating the PO", async () => {
    const confirmedPayload = {
      proposalId: 101,
      action: "inventory:create-draft-po",
      payload: {
        suggestion: {
          productVariantId: 77,
          suggestedQty: 10,
          vendorId: 9,
          warehouseId: 5,
        },
      },
    };

    const gateway = { invokeStructured: jest.fn() };
    const confirmation = {
      confirm: jest.fn().mockResolvedValue(confirmedPayload),
      markExecuted: jest.fn().mockResolvedValue(undefined),
    };
    const replenishment = {
      generatePo: jest.fn().mockResolvedValue({ id: "po-1" }),
    };

    const service = buildService(
      buildReorderDb(),
      gateway,
      confirmation,
      replenishment,
    );
    await service.confirmReorderProposal(
      "org-1",
      "user-1",
      101,
      "101.9999999999.abc123",
    );

    expect(confirmation.markExecuted).toHaveBeenCalledTimes(1);
    expect(confirmation.markExecuted).toHaveBeenCalledWith(101, {
      poId: "po-1",
    }, "org-1");
  });

  it("should throw NotFoundException when confirmed payload has no vendorId", async () => {
    const confirmedPayload = {
      proposalId: 102,
      action: "inventory:create-draft-po",
      payload: {
        suggestion: {
          productVariantId: 77,
          suggestedQty: 10,
          vendorId: null,
          warehouseId: 5,
        },
      },
    };

    const gateway = { invokeStructured: jest.fn() };
    const generatePo = jest.fn();
    const confirmation = {
      confirm: jest.fn().mockResolvedValue(confirmedPayload),
      markExecuted: jest.fn(),
    };
    const replenishment = { generatePo };

    const service = buildService(
      buildReorderDb(),
      gateway,
      confirmation,
      replenishment,
    );
    await expect(
      service.confirmReorderProposal("org-1", "user-1", 102, "102.xxx.yyy"),
    ).rejects.toThrow(NotFoundException);
    expect(generatePo).not.toHaveBeenCalled();
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

const MOCK_VENDOR_PERFORMANCE = {
  openPoCount: 3,
  totalSpend: "12000",
  fillRate: 0.87,
  onTimeRate: 0.72,
  avgLeadTimeDays: 9,
};

describe("InvAiExplainService - stale evidence on confirm", () => {
  const material = {
    productVariantId: 77,
    currentOnHand: 3,
    suggestedOrderQty: 42,
    vendorId: 5,
  };
  const asSuggestion = (onHand: number) => ({
    productVariantId: 77,
    currentOnHand: onHand,
    suggestedQty: 42,
    vendorId: 5,
    warehouseId: 9,
  });

  function build(onHandNow: number | null) {
    const confirmation = {
      confirm: jest.fn().mockResolvedValue({
        proposalId: 1,
        payload: {
          suggestion: asSuggestion(3),
          evidenceHash: hashReorderEvidence(material),
        },
      }),
      markExecuted: jest.fn().mockResolvedValue(undefined),
    };
    const replenishment = {
      getSuggestionForVariant: jest
        .fn()
        .mockResolvedValue(onHandNow === null ? null : asSuggestion(onHandNow)),
      generatePo: jest.fn().mockResolvedValue({ id: 900 }),
    };
    return { confirmation, replenishment };
  }

  it("posts the order when the position is unchanged", async () => {
    // The control. Without it the refusals below would also pass against a
    // guard that rejected every confirmation.
    const { confirmation, replenishment } = build(3);
    const service = buildService({}, {}, confirmation, replenishment);
    await expect(
      service.confirmReorderProposal("org-1", "user-1", 1, "tok"),
    ).resolves.toEqual({ id: 900 });
    expect(replenishment.generatePo).toHaveBeenCalled();
  });

  it("refuses when on-hand moved while the proposal was waiting", async () => {
    // Someone received 500 units between the proposal and the click. Posting
    // the original 42 would order against a position that no longer exists.
    const { confirmation, replenishment } = build(503);
    const service = buildService({}, {}, confirmation, replenishment);
    await expect(
      service.confirmReorderProposal("org-1", "user-1", 1, "tok"),
    ).rejects.toThrow(ConflictException);
    expect(replenishment.generatePo).not.toHaveBeenCalled();
  });

  it("refuses when the suggestion has gone away entirely", async () => {
    // Restocked past the reorder point: there is no suggestion left to act on,
    // and "no evidence" must not read the same as "evidence unchanged".
    const { confirmation, replenishment } = build(null);
    const service = buildService({}, {}, confirmation, replenishment);
    await expect(
      service.confirmReorderProposal("org-1", "user-1", 1, "tok"),
    ).rejects.toThrow(ConflictException);
    expect(replenishment.generatePo).not.toHaveBeenCalled();
  });

  it("hashes only the figures that would change the decision", async () => {
    // A rename must not invalidate a proposal, or the warning gets clicked
    // through; a quantity change must.
    expect(hashReorderEvidence(material)).toBe(
      hashReorderEvidence({ ...material }),
    );
    expect(hashReorderEvidence({ ...material, suggestedOrderQty: 43 })).not.toBe(
      hashReorderEvidence(material),
    );
  });
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
    const vendors = {
      getVendorPerformance: jest
        .fn()
        .mockResolvedValue(MOCK_VENDOR_PERFORMANCE),
    };

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
    const vendors = {
      getVendorPerformance: jest
        .fn()
        .mockResolvedValue(MOCK_VENDOR_PERFORMANCE),
    };

    const service = buildService(db, gateway, undefined, undefined, vendors);
    const result = await service.getSupplierDelayBriefing("org-1", "user-1");

    expect(result.narration).toBe(aiNarration);
    expect(result.vendors[0]!.performance).toEqual(MOCK_VENDOR_PERFORMANCE);
  });

  it("should have performance figures from getVendorPerformance, not from invokeText", async () => {
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
    const vendors = {
      getVendorPerformance: jest
        .fn()
        .mockResolvedValue(MOCK_VENDOR_PERFORMANCE),
    };

    const service = buildService(db, gateway, undefined, undefined, vendors);
    const result = await service.getSupplierDelayBriefing("org-1", "user-1");

    expect(result.vendors[0]!.performance["onTimeRate"]).toBe(0.72);
    expect(result.vendors[0]!.performance["avgLeadTimeDays"]).toBe(9);
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
    const vendors = {
      getVendorPerformance: jest
        .fn()
        .mockResolvedValue(MOCK_VENDOR_PERFORMANCE),
    };

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
    const vendors = {
      getVendorPerformance: jest
        .fn()
        .mockResolvedValue(MOCK_VENDOR_PERFORMANCE),
    };

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
    const vendors = { getVendorPerformance: jest.fn() };

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
    const vendors = {
      getVendorPerformance: jest
        .fn()
        .mockResolvedValue(MOCK_VENDOR_PERFORMANCE),
    };

    const service = buildService(db, gateway, undefined, undefined, vendors);
    const result = await service.getSupplierDelayBriefing("org-1", "user-1", 1);

    expect(result.vendors).toHaveLength(1);
    expect(result.vendors[0]!.vendorId).toBe(1);
    expect(result.vendors[0]!.vendorName).toBe("ACME Corp");
  });
});
