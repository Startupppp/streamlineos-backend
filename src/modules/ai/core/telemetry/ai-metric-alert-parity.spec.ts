import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LogSpanExporter } from "../../../../common/observability/log-span-exporter";
import { SEAM_BUDGETS } from "../../../../common/observability/seam-budgets";
import { resetSpanExporter, setSpanExporter } from "../../../../common/observability";
import { AI_CALL_SPAN_NAME, AiCallMetrics } from "./ai-call-metrics";

/**
 * A metric nothing reads is not a metric, and a predicate that matches text no
 * line produces is silently inert. Ticket 31 established the method: parse both
 * sides — the emitter and the predicate — and compare, so neither can be a
 * hard-coded restatement of the other.
 *
 * This extends that to the AI metrics. It adds no new alert predicate; it proves
 * the new span lands in the stream the existing ones already read, is shaped the
 * way they require, and cannot be mis-bucketed into another seam's budget.
 */
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
const metricsSource = read(__dirname, "ai-call-metrics.ts");

describe("the AI metric reaches the stream the span alerts already read", () => {
  const emittedMessage = firstCapture(exporterSource, /message:\s*"([^"]+)"/);

  it("(anti-vacuous) the exporter's message literal is parsed out of its source", () => {
    expect(emittedMessage).not.toBeNull();
  });

  it.each(["alert-p95.mjs", "alert-seam-latency.mjs"])(
    "%s keys on that exact literal",
    (script) => {
      const compared = firstCapture(
        read(SCRIPTS, script),
        /record\.message\s*(?:!==|===)\s*"([^"]+)"/,
      );
      expect(compared).not.toBeNull();
      expect(compared).toBe(emittedMessage);
    },
  );

  it("the AI metric is emitted through that exporter's port, not a private log line", () => {
    expect(metricsSource).toContain('from "../../../../common/observability"');
    expect(metricsSource).toContain("startSpan(AI_CALL_SPAN_NAME");
  });

  /**
   * Both sides real: a genuine `AiCallMetrics` finish, serialised by the genuine
   * `LogSpanExporter`, parsed back as the alert would parse it.
   */
  it("a real emitted line carries every field the p95 alert reads", () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const spy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      });

    setSpanExporter(new LogSpanExporter());
    try {
      AiCallMetrics.begin({ feature: "ai:chat", orgId: "org_a" }).finish("ok", {
        model: "gpt-4o-mini",
        promptTokens: 10,
        completionTokens: 5,
      });
    } finally {
      resetSpanExporter();
      spy.mockRestore();
      void original;
    }

    expect(written).toHaveLength(1);
    const record: unknown = JSON.parse(written[0] as string);
    if (record === null || typeof record !== "object") throw new Error("not a record");
    const line = record as Record<string, unknown>;

    expect(line["message"]).toBe(emittedMessage);
    expect(line["name"]).toBe(AI_CALL_SPAN_NAME);
    expect(typeof line["latencyMs"]).toBe("number");
    expect(Number.isFinite(line["latencyMs"])).toBe(true);
    expect(line["status"]).toBe("ok");
    expect(typeof line["timestamp"]).toBe("string");
    expect(Number.isNaN(new Date(line["timestamp"] as string).getTime())).toBe(false);
    // The dimensions must survive the exporter's own redaction pass.
    expect(line["ai.outcome"]).toBe("ok");
    expect(line["ai.provider_ms"]).toBe(0);
    expect(line["ai.tok_in"]).toBe(10);
  });
});

describe("the AI span groups as one endpoint rather than fragmenting", () => {
  const p95 = read(SCRIPTS, "alert-p95.mjs");

  it("(anti-vacuous) the normaliser's short-circuit is parsed out of the script", () => {
    expect(p95).toContain("const firstSpace = name.indexOf(\" \");");
    expect(p95).toContain("if (firstSpace === -1) return name;");
  });

  it("the span name has no space, so the normaliser returns it unchanged", () => {
    // The request span is `${method} ${path}` and gets folded to a route
    // template; a name with no space is passed through untouched, which is what
    // keeps every AI call in one bucket instead of one per correlation id.
    expect(AI_CALL_SPAN_NAME).not.toContain(" ");
  });
});

describe("the AI span cannot be mis-bucketed into another seam's budget", () => {
  const seamLatency = read(SCRIPTS, "alert-seam-latency.mjs");
  const seamKey = firstCapture(seamLatency, /SEAM_ATTRIBUTE_KEY\s*=\s*"([^"]+)"/);

  it("(anti-vacuous) the seam attribute key is parsed out of the script", () => {
    expect(seamKey).not.toBeNull();
  });

  it("the alert skips a span whose seam is not a declared budget, and AI declares none", () => {
    expect(seamLatency).toContain("if (!(seamName in SEAM_BUDGETS)) continue;");
    expect(Object.keys(SEAM_BUDGETS)).not.toContain(AI_CALL_SPAN_NAME);
  });

  it("the AI metric sets no seam attribute at all", () => {
    const spans: Array<Record<string, unknown>> = [];
    setSpanExporter({ export: (span) => spans.push({ ...span.attributes }) });
    try {
      AiCallMetrics.begin({ feature: "ai:chat" }).finish("ok");
    } finally {
      resetSpanExporter();
    }
    expect(Object.keys(spans[0] ?? {})).not.toContain(seamKey as string);
  });
});

describe("ai_usage_logs still answers the tenant-cost alert after this ticket's changes", () => {
  const tenantCost = read(SCRIPTS, "alert-tenant-cost.mjs");
  const schema = read(SRC, "db", "schema", "common", "ai-usage.ts");
  const usageService = read(__dirname, "..", "services", "ai-usage.service.ts");

  const declaredColumns = [...schema.matchAll(/\w+\("([a-z_]+)"/g)].map((m) => m[1]);

  it("(anti-vacuous) columns parse out of the Drizzle declaration", () => {
    expect(declaredColumns).toContain("org_id");
    expect(declaredColumns).toContain("credits_milli");
  });

  it.each(["org_id", "credits_milli", "created_at", "feature"])(
    "the alert's `%s` exists on the table",
    (column) => {
      expect(tenantCost).toContain(column);
      expect(declaredColumns).toContain(column);
    },
  );

  it("the write site still populates the two columns the alert aggregates", () => {
    // `SUM(credits_milli) … GROUP BY org_id` is the whole metric; a refactor that
    // stopped writing either would leave the alert reporting every tenant at zero.
    expect(usageService).toContain("orgId,");
    expect(usageService).toContain("creditsMilli,");
  });

  it("the phase split lands in metadata, not in a column the alert would have to learn", () => {
    expect(usageService).toContain("function timingMetadata");
    expect(declaredColumns).toContain("metadata");
    for (const phase of ["queueMs", "providerMs", "appOverheadMs", "ttftMs"])
      expect(usageService).toContain(phase);
  });
});
