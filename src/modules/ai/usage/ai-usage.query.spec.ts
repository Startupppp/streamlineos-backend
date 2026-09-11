import { queryAiUsage } from "./ai-usage.query";

function thenableChain(result: unknown[]) {
  const p = Promise.resolve(result);
  const chain: Record<string, unknown> = {};
  const _self = () => chain;
  for (const m of ["select", "from", "where", "groupBy", "orderBy", "limit"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain["then"] = (res: Parameters<Promise<unknown>["then"]>[0], rej: Parameters<Promise<unknown>["then"]>[1]) => p.then(res, rej);
  chain["catch"] = (rej: Parameters<Promise<unknown>["catch"]>[0]) => p.catch(rej);
  return chain;
}

function buildDb(results: unknown[][]) {
  let i = 0;
  return {
    select: jest.fn().mockImplementation(() => thenableChain(results[i++] ?? [])),
  };
}

describe("queryAiUsage — additive shape", () => {
  const totalsRow = { totalTokens: 100, promptTokens: 60, completionTokens: 40, estimatedCostUsd: "0.001", requestCount: 5 };
  const latencyRow = { avgLatencyMs: 250, p95LatencyMs: 800, errorRate: 0.05 };
  const feedbackRow = { feature: "kb-answer", up: 4, down: 1, total: 5 };
  const suggestionsRow = { accepted: 10, rejected: 2, pending: 3 };

  const defaultResults = () => [
    [totalsRow],
    [],
    [],
    [latencyRow],
    [feedbackRow],
    [suggestionsRow],
  ];

  it("returns original shape fields intact", async () => {
    const db = buildDb(defaultResults()) as never;
    const result = await queryAiUsage(db, "org-1");
    expect(result).toHaveProperty("totals");
    expect(result).toHaveProperty("byFeature");
    expect(result).toHaveProperty("daily");
  });

  it("includes additive performance keys", async () => {
    const db = buildDb(defaultResults()) as never;
    const result = await queryAiUsage(db, "org-1");
    expect(result).toHaveProperty("performance");
    expect(result.performance).toHaveProperty("avgLatencyMs");
    expect(result.performance).toHaveProperty("p95LatencyMs");
    expect(result.performance).toHaveProperty("errorRate");
  });

  it("includes additive acceptance keys", async () => {
    const db = buildDb(defaultResults()) as never;
    const result = await queryAiUsage(db, "org-1");
    expect(result).toHaveProperty("acceptance");
    expect(result.acceptance).toHaveProperty("feedbackByFeature");
    expect(result.acceptance).toHaveProperty("supportSuggestions");
    expect(result.acceptance.supportSuggestions).toHaveProperty("accepted");
    expect(result.acceptance.supportSuggestions).toHaveProperty("rejected");
    expect(result.acceptance.supportSuggestions).toHaveProperty("pending");
  });

  it("gracefully returns null performance values when no latency data", async () => {
    const noLatencyResults = [
      [totalsRow],
      [],
      [],
      [],
      [feedbackRow],
      [suggestionsRow],
    ];
    const db = buildDb(noLatencyResults) as never;
    const result = await queryAiUsage(db, "org-1");
    expect(result.performance.avgLatencyMs).toBeNull();
    expect(result.performance.p95LatencyMs).toBeNull();
    expect(result.performance.errorRate).toBe(0);
  });
});
