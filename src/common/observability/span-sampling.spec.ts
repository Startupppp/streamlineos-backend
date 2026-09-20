import {
  HIGH_FREQUENCY_SEAMS,
  LogSpanExporter,
  resolveSpanSampleRate,
} from "./log-span-exporter";
import type { FinishedSpan } from "./tracing";

function span(overrides: Partial<FinishedSpan> = {}): FinishedSpan {
  return {
    name: "db.query.execute",
    traceId: "t-1",
    spanId: "s-1",
    sampled: true,
    parentSpanId: null,
    startedAt: Date.now(),
    durationMs: 2,
    status: "ok",
    attributes: {},
    ...overrides,
  };
}

function captureStdout() {
  const lines: string[] = [];
  const spy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("span sampling", () => {
  it("exports everything outside production, so a developer sees the whole trace", () => {
    expect(resolveSpanSampleRate({ NODE_ENV: "test" })).toBe(1);
    expect(resolveSpanSampleRate({ NODE_ENV: "development" })).toBe(1);
  });

  it("samples in production, where the statement seams dominate the log stream", () => {
    expect(resolveSpanSampleRate({ NODE_ENV: "production" })).toBeLessThan(1);
    expect(resolveSpanSampleRate({ NODE_ENV: "production" })).toBeGreaterThan(0);
  });

  it("lets an operator set the rate explicitly", () => {
    expect(
      resolveSpanSampleRate({ NODE_ENV: "production", OBSERVABILITY_SPAN_SAMPLE_RATE: "0.5" }),
    ).toBe(0.5);
    expect(
      resolveSpanSampleRate({ NODE_ENV: "production", OBSERVABILITY_SPAN_SAMPLE_RATE: "1" }),
    ).toBe(1);
  });

  it("drops a sampled-out statement span", () => {
    const out = captureStdout();
    try {
      new LogSpanExporter(0.1, () => 0.9).export(span());
      expect(out.lines).toHaveLength(0);
    } finally {
      out.restore();
    }
  });

  it("keeps a statement span that wins the sample", () => {
    const out = captureStdout();
    try {
      new LogSpanExporter(0.1, () => 0.01).export(span());
      expect(out.lines).toHaveLength(1);
    } finally {
      out.restore();
    }
  });

  it("never drops a failed span, however aggressive the rate", () => {
    const out = captureStdout();
    try {
      new LogSpanExporter(0.01, () => 0.99).export(span({ status: "error" }));
      expect(out.lines).toHaveLength(1);
    } finally {
      out.restore();
    }
  });

  it("never samples a seam that already fires only once per request", () => {
    const out = captureStdout();
    try {
      new LogSpanExporter(0.01, () => 0.99).export(span({ name: "GET /v1/tickets" }));
      expect(out.lines).toHaveLength(1);
      expect(HIGH_FREQUENCY_SEAMS.has("GET /v1/tickets")).toBe(false);
    } finally {
      out.restore();
    }
  });

  it("records the rate on a sampled line so a percentile can be weighted", () => {
    const out = captureStdout();
    try {
      new LogSpanExporter(0.25, () => 0.01).export(span());
      const parsed: unknown = JSON.parse(out.lines[0] ?? "{}");
      expect(parsed).toMatchObject({ name: "db.query.execute", sampleRate: 0.25 });
    } finally {
      out.restore();
    }
  });

  it("omits the rate when nothing was sampled away", () => {
    const out = captureStdout();
    try {
      new LogSpanExporter(1, () => 0.99).export(span());
      const parsed = JSON.parse(out.lines[0] ?? "{}") as Record<string, unknown>;
      expect(parsed.sampleRate).toBeUndefined();
    } finally {
      out.restore();
    }
  });

  it("covers the per-statement, per-borrow and per-command seams", () => {
    expect(HIGH_FREQUENCY_SEAMS.has("db.query.execute")).toBe(true);
    expect(HIGH_FREQUENCY_SEAMS.has("db.pool.wait")).toBe(true);
    expect(HIGH_FREQUENCY_SEAMS.has("cache.roundtrip")).toBe(true);
  });
});
