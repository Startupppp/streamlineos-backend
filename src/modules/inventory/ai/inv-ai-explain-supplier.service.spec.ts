import { ServiceUnavailableException } from "@nestjs/common";
import { InvAiExplainService } from "./inv-ai-explain.service";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { VendorScorecardService } from "../vendors/vendor-scorecard.service";
import type { InvAiService } from "./inv-ai.service";
import type { Db } from "../../../db/drizzle.module";
import { withDelegatingTransaction } from "../../../test/delegating-transaction";

function buildService(
  db: unknown,
  gateway: Partial<AiGatewayService>,
  scorecards?: Partial<VendorScorecardService>,
  insights?: Partial<InvAiService>,
) {
  return new InvAiExplainService(
    withDelegatingTransaction(db as object) as Db,
    gateway as AiGatewayService,
    (scorecards ?? {}) as VendorScorecardService,
    (insights ?? {}) as InvAiService,
  );
}

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
      scorecardsFor: jest
        .fn()
        .mockResolvedValue(new Map([[1, {}], [2, {}]])),
    };

    const service = buildService(db, gateway, vendors as unknown as VendorScorecardService);
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
      scorecardsFor: jest.fn().mockResolvedValue(new Map([[1, {}]])),
    };

    const service = buildService(db, gateway, vendors as unknown as VendorScorecardService);
    const result = await service.getSupplierDelayBriefing("org-1", "user-1");

    expect(result.narration).toBe(aiNarration);
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
    const vendors = { scorecardsFor: jest.fn().mockResolvedValue(new Map([[1, {}]])) };

    const service = buildService(db, gateway, vendors as unknown as VendorScorecardService);
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
      scorecardsFor: jest.fn().mockResolvedValue(new Map([[1, {}]])),
    };

    const service = buildService(db, gateway, vendors as unknown as VendorScorecardService);
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
    const vendors = { scorecardsFor: jest.fn() };

    const service = buildService(db, gateway, vendors as unknown as VendorScorecardService);
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
    const vendors = { scorecardsFor: jest.fn().mockResolvedValue(new Map([[1, {}]])) };

    const service = buildService(db, gateway, vendors as unknown as VendorScorecardService);
    const result = await service.getSupplierDelayBriefing("org-1", "user-1", 1);

    expect(result.vendors).toHaveLength(1);
    expect(result.vendors[0]!.vendorId).toBe(1);
  });
});
