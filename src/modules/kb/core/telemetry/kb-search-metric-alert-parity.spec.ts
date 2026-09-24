import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SENSITIVE_EXACT, SENSITIVE_SUBSTRINGS } from "../../../../common/observability/redact";
import { resetSpanExporter, setSpanExporter } from "../../../../common/observability";
import { LogSpanExporter } from "../../../../common/observability/log-span-exporter";
import {
  KB_SEARCH_OUTCOMES,
  KB_SEARCH_SPAN_NAME,
  KbSearchMetrics,
} from "./kb-search-metrics";

const BACKEND_ROOT = resolve(__dirname, "../../../../..");
const SCRIPTS = join(BACKEND_ROOT, "src", "scripts");
const SRC = join(BACKEND_ROOT, "src");

function read(...segments: string[]): string {
  return readFileSync(join(...segments), "utf8");
}

function firstCapture(text: string, pattern: RegExp): string | null {
  return pattern.exec(text)?.[1] ?? null;
}

const exporterSource = read(SRC, "common", "observability", "log-span-exporter.ts");
const metricsSource = read(__dirname, "kb-search-metrics.ts");
const searchServiceSource = read(SRC, "modules", "kb", "retrieval", "kb-search.service.ts");

function emitOneLine(run: (metrics: KbSearchMetrics) => void): Record<string, unknown> {
  const written: string[] = [];
  const spy = jest
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });

  setSpanExporter(new LogSpanExporter());
  try {
    run(KbSearchMetrics.begin({ orgId: "org_a" }));
  } finally {
    resetSpanExporter();
    spy.mockRestore();
  }

  expect(written).toHaveLength(1);
  const record: unknown = JSON.parse(written[0] as string);
  if (record === null || typeof record !== "object") throw new Error("not a record");
  return record as Record<string, unknown>;
}

describe("the KB Search metric reaches the structured log stream", () => {
  const emittedMessage = firstCapture(exporterSource, /message:\s*"([^"]+)"/);

  it("(anti-vacuous) the exporter's message literal is parsed out of its source", () => {
    expect(emittedMessage).not.toBeNull();
  });

  it("the KB Search metric is emitted through the exporter's port, not a private log line", () => {
    expect(metricsSource).toContain('from "../../../../common/observability"');
    expect(metricsSource).toContain("startSpan(KB_SEARCH_SPAN_NAME");
  });

  it("the span name the metric declares is the right value", () => {
    const emitted = firstCapture(metricsSource, /KB_SEARCH_SPAN_NAME\s*=\s*"([^"]+)"/);
    expect(emitted).toBe(KB_SEARCH_SPAN_NAME);
    expect(emitted).toBe("kb.search.operation");
  });

  it("carries every outcome the spec requires", () => {
    for (const required of ["found", "not_found", "denied", "error"])
      expect(KB_SEARCH_OUTCOMES).toContain(required);
  });

  it("a real emitted line carries every field consumers would read", () => {
    const line = emitOneLine((metrics) => {
      metrics.finish("found", { results: 12 });
    });

    expect(line["message"]).toBe("SPAN");
    expect(line["name"]).toBe(KB_SEARCH_SPAN_NAME);
    expect(typeof line["latencyMs"]).toBe("number");
    expect(Number.isFinite(line["latencyMs"])).toBe(true);
    expect(line["status"]).toBe("ok");
    expect(Number.isNaN(new Date(line["timestamp"] as string).getTime())).toBe(false);
    expect(line["kb.search.outcome"]).toBe("found");
    expect(line["kb.search.results"]).toBe(12);
    expect(typeof line["kb.search.duration_ms"]).toBe("number");
    expect(line["org.id"]).toBe("org_a");
  });

  it("an error outcome closes the span with status=error", () => {
    const line = emitOneLine((metrics) => metrics.finish("error"));
    expect(line["status"]).toBe("error");
  });

  it("a non-error outcome closes the span with status=ok", () => {
    const line = emitOneLine((metrics) => metrics.finish("denied"));
    expect(line["status"]).toBe("ok");
  });
});

describe("the KB Search span carries no tenant content and survives redaction", () => {
  it("writes no attribute key the log redactor would blank", () => {
    const attributes: Array<Record<string, unknown>> = [];
    setSpanExporter({ export: (span) => attributes.push({ ...span.attributes }) });
    try {
      const metrics = KbSearchMetrics.begin({ orgId: "org_a" });
      metrics.finish("found", { results: 5 });
    } finally {
      resetSpanExporter();
    }

    const keys = Object.keys(attributes[0] ?? {});
    expect(keys.length).toBeGreaterThan(0);
    const normalise = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const blanked = keys.filter(
      (key) =>
        SENSITIVE_EXACT.has(normalise(key)) ||
        SENSITIVE_SUBSTRINGS.some((needle) => normalise(key).includes(needle)),
    );
    expect(blanked).toEqual([]);
  });

  it("declares no attribute whose value could be a search query or a result title", () => {
    const declared = [...metricsSource.matchAll(/this\.attributes\["([^"]+)"\]/g)].map(
      (match) => match[1] as string,
    );
    expect(declared).toEqual(
      expect.arrayContaining(["kb.search.outcome", "kb.search.results"]),
    );
    const allowed = new Set([
      "org.id",
      "kb.search.outcome",
      "kb.search.duration_ms",
      "kb.search.results",
    ]);
    expect(declared.filter((key) => !allowed.has(key))).toEqual([]);
  });

  it("the emitter interpolates nothing into an attribute value", () => {
    expect(metricsSource).not.toMatch(/this\.attributes\[[^\]]+\]\s*=\s*`/);
    expect(metricsSource).not.toContain("query");
    expect(metricsSource).not.toContain("title");
  });
});

describe("the KB Search emitter is wired at the search service's real decision points", () => {
  function outcomesPassedToFinish(source: string): string[] {
    return [...source.matchAll(/metrics\.finish\(([^;]*?)\)\s*;/gs)].flatMap((call) =>
      [...(call[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((quoted) => quoted[1] ?? ""),
    );
  }

  const finished = outcomesPassedToFinish(searchServiceSource);

  it("(anti-vacuous) outcomes are parsed off real finish calls", () => {
    expect(finished.length).toBeGreaterThan(0);
    expect(outcomesPassedToFinish("return;")).toEqual([]);
  });

  it("finishes no outcome the frozen enum cannot produce", () => {
    const declared: readonly string[] = KB_SEARCH_OUTCOMES;
    expect(finished.filter((outcome) => !declared.includes(outcome))).toEqual([]);
  });

  it("covers found, not_found, denied and error branches", () => {
    for (const outcome of ["found", "not_found", "denied", "error"])
      expect(finished).toContain(outcome);
  });

  it("the search service imports KbSearchMetrics", () => {
    expect(searchServiceSource).toContain("KbSearchMetrics");
  });

  it("the seam attribute is never set on the search span, so it cannot enter a seam budget", () => {
    const seamLatency = read(SCRIPTS, "alert-seam-latency.mjs");
    const seamKey = firstCapture(seamLatency, /SEAM_ATTRIBUTE_KEY\s*=\s*"([^"]+)"/);
    expect(seamKey).not.toBeNull();
    expect(metricsSource).not.toContain(`"${seamKey ?? ""}"`);
    expect(KB_SEARCH_SPAN_NAME).not.toContain(" ");
  });
});
