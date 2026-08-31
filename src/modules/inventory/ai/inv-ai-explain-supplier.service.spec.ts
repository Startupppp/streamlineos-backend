import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { InvAiExplainService } from "./inv-ai-explain.service";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { AiConfirmationService } from "../../ai/confirmation/ai-confirmation.service";
import type { InvReplenishmentService } from "../replenishment/inv-replenishment.service";
import type { InvVendorsService } from "../vendors/inv-vendors.service";

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
