/**
 * The surface under test is `@NoTenantTransaction()`, so it opens its own short
 * tenant transaction around the reads that must commit before a provider call.
 * The real helper reaches `withTenant` -> `resolvePlacement`, which is
 * control-plane infrastructure this unit spec has no business booting; the
 * pass-through keeps the subject of these tests what it was. Same shape as
 * `timesheets/core/timesheets-ai-stream.spec.ts`. That the transaction is
 * really opened is pinned by the placement-bypass gate, not here.
 */
jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async (_db: unknown, read: () => Promise<unknown>) => read(),
}));

import { InvAiService } from "../inv-ai.service";
import { InvAiExplainService } from "../inv-ai-explain.service";
import type { AiGatewayService } from "../../../ai/core/gateway/ai-gateway.service";

function serviceWithCandidates(
  candidates: Array<{ insightType: string; severity: string }>,
) {
  // F3. The third argument is `WarehouseScopeService`: the insights list and
  // status route now carry the same warehouse gate as the anomaly queue. The
  // ops brief itself does not consult it — it is a count, not a row list — so an
  // inert stand-in is enough here.
  const service = new InvAiService({} as never, {} as never, {} as never);
  jest
    .spyOn(service as unknown as { collectCandidates: () => Promise<unknown> }, "collectCandidates")
    .mockResolvedValue(candidates);
  return service;
}

describe("INV-101 the deterministic operations brief", () => {
  it("reports one signal per detector, with a route for each", async () => {
    const brief = await serviceWithCandidates([]).getOpsBrief("org-1");

    expect(brief.signals).toHaveLength(6);
    // A signal a reader cannot open is a dead end; the acceptance criterion is
    // that every figure links to the screen that computed it.
    for (const signal of brief.signals) {
      expect(signal.href.startsWith("/inventory/")).toBe(true);
      expect(signal.label.length).toBeGreaterThan(0);
    }
    expect(brief.totalSignals).toBe(0);
  });

  it("counts each signal and totals them", async () => {
    const brief = await serviceWithCandidates([
      { insightType: "stockout_risk", severity: "low" },
      { insightType: "stockout_risk", severity: "high" },
      { insightType: "expiry_risk", severity: "medium" },
    ]).getOpsBrief("org-1");

    const byKey = Object.fromEntries(brief.signals.map((s) => [s.key, s]));
    expect(byKey["stockout_risk"]!.count).toBe(2);
    expect(byKey["expiry_risk"]!.count).toBe(1);
    expect(byKey["dead_stock"]!.count).toBe(0);
    expect(brief.totalSignals).toBe(3);
  });

  it("takes the worst severity present, not the commonest", async () => {
    // Forty low-severity rows beside one high-severity row is a high-severity
    // situation. Averaging would bury the one that matters.
    const brief = await serviceWithCandidates([
      ...Array.from({ length: 40 }, () => ({
        insightType: "stockout_risk",
        severity: "low",
      })),
      { insightType: "stockout_risk", severity: "high" },
    ]).getOpsBrief("org-1");

    const stockout = brief.signals.find((s) => s.key === "stockout_risk");
    expect(stockout!.severity).toBe("high");
  });

  it("reports no severity for a signal with nothing in it", async () => {
    const brief = await serviceWithCandidates([]).getOpsBrief("org-1");
    expect(brief.signals.every((s) => s.severity === "none")).toBe(true);
  });
});

describe("INV-101 the brief does not spend credits on its own", () => {
  const emptyBrief = {
    generatedAt: "2026-08-28T00:00:00.000Z",
    totalSignals: 0,
    signals: [],
  };
  const busyBrief = {
    generatedAt: "2026-08-28T00:00:00.000Z",
    totalSignals: 4,
    signals: [
      {
        key: "stockout_risk",
        label: "Stockout risk",
        href: "/inventory/replenishment",
        count: 4,
        severity: "high" as const,
      },
    ],
  };

  function build(brief: unknown, gateway: Partial<AiGatewayService>) {
    // F4. Four dependencies now: the confirmation, replenishment and access
    // services left with the reorder proposal (`proposals/`).
    return new InvAiExplainService(
      {} as never,
      gateway as AiGatewayService,
      {} as never,
      { getOpsBrief: jest.fn().mockResolvedValue(brief) } as never,
    );
  }

  it("never calls the provider when there is nothing to narrate", async () => {
    // The ticket's core promise. Paying a model to write "nothing is wrong" is
    // money for a sentence we can write ourselves, and it would be spent every
    // time a dashboard rendered.
    const invokeStructured = jest.fn();
    const result = await build(emptyBrief, { invokeStructured }).narrateOpsBrief(
      "org-1",
      "user-1",
    );

    expect(invokeStructured).not.toHaveBeenCalled();
    expect(result.narration.explanation).toBe("No open inventory signals.");
    expect(result.narration.provenance.model).toBe("none");
  });

  it("calls the provider once there is something to say", async () => {
    // The control. Without it the assertion above would also pass against a
    // service that never called the provider at all.
    const invokeStructured = jest.fn().mockResolvedValue({
      ok: true,
      model: "fast",
      correlationId: "corr-9",
      latencyMs: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      data: {
        status: "ok",
        explanation: "Stockout risk is the first thing to look at.",
        factors: [{ label: "Stockout risk", value: "4", isFactual: true }],
        recommendations: [
          {
            action: "review_reorder_suggestion",
            rationale: "Four variants are below their reorder point.",
            evidence: [],
          },
        ],
      },
    });

    const result = await build(busyBrief, { invokeStructured }).narrateOpsBrief(
      "org-1",
      "user-1",
    );

    expect(invokeStructured).toHaveBeenCalledTimes(1);
    expect(invokeStructured.mock.calls[0]![0].charge).toBe(true);
    expect(result.narration.actions[0]!.href).toBe("/inventory/replenishment");
    expect(result.narration.provenance.model).toBe("fast");
  });

  it("refuses a citation invented over an aggregate", async () => {
    // The brief has no row ids at all, so any citation is invented by
    // construction -- a useful place to prove the allowlist still bites.
    const invokeStructured = jest.fn().mockResolvedValue({
      ok: true,
      model: "fast",
      correlationId: "corr-9",
      latencyMs: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      data: {
        status: "ok",
        explanation: "Look at variant 12345.",
        factors: [],
        recommendations: [
          {
            action: "open_stock_movements",
            rationale: "Invented.",
            evidence: [{ kind: "product_variant", id: 12345 }],
          },
        ],
      },
    });

    await expect(
      build(busyBrief, { invokeStructured }).narrateOpsBrief("org-1", "user-1"),
    ).rejects.toThrow(/never retrieved/);
  });
});
