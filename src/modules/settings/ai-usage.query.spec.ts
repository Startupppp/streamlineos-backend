import { queryAiUsage } from "./ai-usage.query";

const makeMockDb = (overrides: Record<string, unknown[]> = {}) => {
  const defaults: Record<string, unknown[]> = {
    totals: [{ totalTokens: 100, promptTokens: 60, completionTokens: 40, estimatedCostUsd: "0.001", requestCount: 5 }],
    byFeature: [],
    daily: [],
    latency: [{ avgLatencyMs: 250, p95LatencyMs: 800, errorRate: 0.05 }],
    feedback: [{ feature: "kb-answer", up: 4, down: 1, total: 5 }],
    suggestions: [{ accepted: 10, rejected: 2, pending: 3 }],
    ...overrides,
  };

  let callIndex = 0;
  const responses = [
    defaults.totals,
    defaults.byFeature,
    defaults.daily,
    defaults.latency,
    defaults.feedback,
    defaults.suggestions,
  ];

  const chain = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockImplementation(() => Promise.resolve(responses[callIndex++ % responses.length])),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockImplementation(() => Promise.resolve(responses[callIndex++ % responses.length])),
  };
  return chain;
};

describe("queryAiUsage — additive shape", () => {
  it("returns original shape fields intact", async () => {
    const db = makeMockDb() as never;
    const result = await queryAiUsage(db, "org-1");
    expect(result).toHaveProperty("totals");
    expect(result).toHaveProperty("byFeature");
    expect(result).toHaveProperty("daily");
  });

  it("includes additive performance keys", async () => {
    const db = makeMockDb() as never;
    const result = await queryAiUsage(db, "org-1");
    expect(result).toHaveProperty("performance");
    expect(result.performance).toHaveProperty("avgLatencyMs");
    expect(result.performance).toHaveProperty("p95LatencyMs");
    expect(result.performance).toHaveProperty("errorRate");
  });

  it("includes additive acceptance keys", async () => {
    const db = makeMockDb() as never;
    const result = await queryAiUsage(db, "org-1");
    expect(result).toHaveProperty("acceptance");
    expect(result.acceptance).toHaveProperty("feedbackByFeature");
    expect(result.acceptance).toHaveProperty("supportSuggestions");
    expect(result.acceptance.supportSuggestions).toHaveProperty("accepted");
    expect(result.acceptance.supportSuggestions).toHaveProperty("rejected");
    expect(result.acceptance.supportSuggestions).toHaveProperty("pending");
  });

  it("gracefully returns null performance values when no latency data", async () => {
    const db = makeMockDb({ latency: [] }) as never;
    const result = await queryAiUsage(db, "org-1");
    expect(result.performance.avgLatencyMs).toBeNull();
    expect(result.performance.p95LatencyMs).toBeNull();
    expect(result.performance.errorRate).toBe(0);
  });
});
