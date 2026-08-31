import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { InvAiProposalService } from "./inv-ai-proposal.service";
import { AiGatewayService } from "../../../ai/core/gateway/ai-gateway.service";
import { AiConfirmationService } from "../../../ai/confirmation/ai-confirmation.service";
import { AccessService } from "../../../access/access.service";
import { PoBatchService } from "../../replenishment/forecast/po-batch.service";
import { ForecastPersistenceService } from "../../replenishment/forecast/forecast-persistence.service";

const MOCK_PROPOSAL = {
  proposalId: 101,
  token: "101.9999999999.abc123",
  expiresAt: new Date(Date.now() + 120_000),
};

// The shape `PoBatchService.proposalById` actually returns. The old literal here
// was the pre-C2 suggestion row (`suggestedQty`, `reason`), so `blockedReason`
// was `undefined` -- and `propose` returns early on anything that is not null,
// which is why the gateway was never reached and the prompt came back empty.
const MOCK_SUGGESTION = {
  proposalId: 501,
  productVariantId: 77,
  variantSku: "SKU-077",
  productName: "Widget",
  warehouseId: 5,
  warehouseName: "Main WH",
  vendorId: 9,
  vendorName: "Acme Supply",
  currency: "INR",
  generatedAt: "2026-08-01T00:00:00.000Z",
  reorderPoint: "10",
  // Exact decimal string, as the interface declares.
  suggestedQuantity: "42",
  unitCost: "5.0000",
  duplicateOfPoNumber: null,
  blockedReason: null,
};

// The narration contract: `recommendations` are enum actions carrying evidence
// the server already knows. `suggestedActions` -- a list of sentences the model
// wrote -- is gone, and left `resolveInvAiActions` with nothing to iterate.
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
      rationale: "Forecast cover is below the reorder point above.",
      evidence: [{ kind: "product_variant" as const, id: 77 }],
    },
  ],
};

function buildService(
  gateway: Partial<AiGatewayService>,
  confirmation: Partial<AiConfirmationService>,
  access: Partial<AccessService> = {},
  batches: Partial<PoBatchService> = {},
  forecasts: Partial<ForecastPersistenceService> = {},
) {
  return new InvAiProposalService(
    gateway as AiGatewayService,
    confirmation as AiConfirmationService,
    access as AccessService,
    batches as PoBatchService,
    forecasts as ForecastPersistenceService,
  );
}

describe("InvAiProposalService - propose", () => {
  it("should embed suggestedQty from deterministic engine in the AI user prompt", async () => {
    let capturedUserPrompt = "";

    const gateway = {
      invokeStructuredWithUsage: jest
        .fn()
        .mockImplementation((opts: { prompt: { user: string } }) => {
          capturedUserPrompt = opts.prompt.user;
          return Promise.resolve({ ok: true, data: MOCK_EXPLAIN_RESPONSE, aiUsage: {} });
        }),
    };
    const confirmation = {
      propose: jest.fn().mockResolvedValue(MOCK_PROPOSAL),
    };
    const replenishment = {
      proposalById: jest.fn().mockResolvedValue(MOCK_SUGGESTION),
    };
    // `propose` reads the whole forecast version, not just its id: demand and
    // lead time are destructured a level down, so a bare `{ id }` threw there.
    const forecasts = {
      latest: jest.fn().mockResolvedValue({
        id: 1,
        method: "CROSTON",
        demandCategory: "INTERMITTENT",
        applicable: true,
        refusalReason: null,
        serviceLevel: "0.95",
        safetyStock: "12",
        demand: { mean: "4", stdDev: "1.5" },
        leadTime: { weeks: "2", stdDevWeeks: "0.5" },
        metrics: { mase: "0.8" },
        stockoutCensored: false,
      }),
    };

    const service = buildService(
      gateway,
      confirmation,
      {},
      replenishment,
      forecasts
    );
    const result = await service.propose({orgId: "org-1", userId: "user-1"} as any, {variantId: 77});

    expect(capturedUserPrompt).toContain("42");
    // @ts-ignore - evidence check
    expect(result.evidence["suggestedQuantity"]).toBe("42");
  });
});
