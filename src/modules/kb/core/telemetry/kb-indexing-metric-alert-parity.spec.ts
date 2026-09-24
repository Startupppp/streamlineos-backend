import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LogSpanExporter } from "../../../../common/observability/log-span-exporter";
import { SEAM_BUDGETS } from "../../../../common/observability/seam-budgets";
import { SENSITIVE_EXACT, SENSITIVE_SUBSTRINGS } from "../../../../common/observability/redact";
import { resetSpanExporter, setSpanExporter } from "../../../../common/observability";
import {
  KB_INDEXING_SLO,
  KB_INDEXING_FAULT_OUTCOMES,
  KB_INDEXING_MAX_FAULT_RATIO,
  KB_INDEXING_MIN_FAULTS,
} from "../../../../common/slo";
import {
  KB_INDEXING_OUTCOMES,
  KB_INDEXING_SPAN_NAME,
  KbIndexingMetrics,
  isKbIndexingFault,
} from "./kb-indexing-metrics";

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
const metricsSource = read(__dirname, "kb-indexing-metrics.ts");
const alertSource = read(SCRIPTS, "alert-kb-indexing.mjs");
const serviceSource = read(SRC, "modules", "kb", "retrieval", "kb-indexing.service.ts");

function emitOneLine(run: (metrics: KbIndexingMetrics) => void): Record<string, unknown> {
  const written: string[] = [];
  const spy = jest
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });

  setSpanExporter(new LogSpanExporter());
  try {
    run(KbIndexingMetrics.begin({ contentType: "page", orgId: "org_a" }));
  } finally {
    resetSpanExporter();
    spy.mockRestore();
  }

  expect(written).toHaveLength(1);
  const record: unknown = JSON.parse(written[0] as string);
  if (record === null || typeof record !== "object") throw new Error("not a record");
  return record as Record<string, unknown>;
}

describe("the KB indexing metric reaches the stream the span alerts already read", () => {
  const emittedMessage = firstCapture(exporterSource, /message:\s*"([^"]+)"/);

  it("(anti-vacuous) the exporter's message literal is parsed out of its source", () => {
    expect(emittedMessage).not.toBeNull();
  });

  it("the KB alert keys on that exact literal", () => {
    const compared = firstCapture(alertSource, /record\.message\s*(?:!==|===)\s*"([^"]+)"/);
    expect(compared).not.toBeNull();
    expect(compared).toBe(emittedMessage);
  });

  it("the KB metric is emitted through the exporter's port, not a private log line", () => {
    expect(metricsSource).toContain('from "../../../../common/observability"');
    expect(metricsSource).toContain("startSpan(KB_INDEXING_SPAN_NAME");
  });

  it("the span name the alert filters on is the one the emitter declares", () => {
    const emitted = firstCapture(metricsSource, /KB_INDEXING_SPAN_NAME\s*=\s*"([^"]+)"/);
    const filtered = firstCapture(alertSource, /const SPAN_NAME\s*=\s*"([^"]+)"/);
    expect(emitted).toBe(KB_INDEXING_SPAN_NAME);
    expect(filtered).toBe(emitted);
  });

  it("the outcome attribute the alert reads is the key the emitter writes", () => {
    const filtered = firstCapture(alertSource, /const OUTCOME_ATTRIBUTE_KEY\s*=\s*"([^"]+)"/);
    expect(filtered).not.toBeNull();
    expect(metricsSource).toContain(`this.attributes["${filtered}"] = outcome;`);
  });

  it("(anti-vacuous) the alert's fault list is parsed out of its source, not restated here", () => {
    const declared = firstCapture(alertSource, /const FAULT_OUTCOMES\s*=\s*\[([^\]]*)\]/);
    expect(declared).not.toBeNull();
    const parsed = [...(declared ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(parsed.length).toBeGreaterThan(0);
    expect([...parsed].sort()).toEqual(
      [...KB_INDEXING_OUTCOMES.filter(isKbIndexingFault)].sort(),
    );
  });

  it("names no fault outcome the frozen enum cannot produce", () => {
    const declared = firstCapture(alertSource, /const FAULT_OUTCOMES\s*=\s*\[([^\]]*)\]/) ?? "";
    const parsed = [...declared.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    const unknown = parsed.filter(
      (outcome) => !(KB_INDEXING_OUTCOMES as readonly string[]).includes(outcome),
    );
    expect(unknown).toEqual([]);
  });

  it("carries every outcome the spec requires", () => {
    for (const required of [
      "indexed",
      "reused",
      "skipped_no_content",
      "embedding_unavailable",
      "credits_exhausted",
      "error",
    ])
      expect(KB_INDEXING_OUTCOMES).toContain(required);
  });

  it("a real emitted line carries every field the KB alert reads", () => {
    const line = emitOneLine((metrics) => {
      metrics.embedded(3);
      metrics.finish("indexed", { chunks: 4, reused: false });
    });

    expect(line["message"]).toBe("SPAN");
    expect(line["name"]).toBe(KB_INDEXING_SPAN_NAME);
    expect(typeof line["latencyMs"]).toBe("number");
    expect(Number.isFinite(line["latencyMs"])).toBe(true);
    expect(line["status"]).toBe("ok");
    expect(Number.isNaN(new Date(line["timestamp"] as string).getTime())).toBe(false);
    expect(line["kb.outcome"]).toBe("indexed");
    expect(line["kb.chunks"]).toBe(4);
    expect(line["kb.embedded"]).toBe(3);
    expect(line["kb.reused"]).toBe(false);
    expect(typeof line["kb.duration_ms"]).toBe("number");
    expect(line["org.id"]).toBe("org_a");
  });

  it("a fault outcome closes the span as an error so the status and the outcome agree", () => {
    const line = emitOneLine((metrics) => metrics.finish("credits_exhausted"));
    expect(line["status"]).toBe("error");
    expect(line["kb.outcome"]).toBe("credits_exhausted");
  });

  it("the alert counts a line the emitter actually produced, not a hand-written fixture", () => {
    const line = emitOneLine((metrics) => metrics.finish("indexed", { chunks: 2 }));
    const dir = mkdtempSync(join(tmpdir(), "kb-indexing-parity-"));
    const logPath = join(dir, "spans.log");
    writeFileSync(logPath, `${JSON.stringify(line)}\n`, "utf8");

    const output = execFileSync(
      process.execPath,
      [join(SCRIPTS, "alert-kb-indexing.mjs"), `--log=${logPath}`, "--hours=1"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
      fired: boolean;
      operations: number;
      outcomes: Record<string, number>;
    };

    expect(parsed.operations).toBe(1);
    expect(parsed.outcomes["indexed"]).toBe(1);
    expect(parsed.fired).toBe(false);
  });

  it("exits 2 rather than reporting health when no KB indexing span reached the stream", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-indexing-unwired-"));
    const logPath = join(dir, "spans.log");
    writeFileSync(logPath, `${JSON.stringify({ message: "SPAN", name: "ai.gateway.call" })}\n`, "utf8");

    let status = 0;
    try {
      execFileSync(
        process.execPath,
        [join(SCRIPTS, "alert-kb-indexing.mjs"), `--log=${logPath}`],
        { encoding: "utf8" },
      );
    } catch (error) {
      status = (error as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});

describe("the KB indexing span carries no tenant content and survives redaction", () => {
  it("writes no attribute key the log redactor would blank", () => {
    const attributes: Array<Record<string, unknown>> = [];
    setSpanExporter({ export: (span) => attributes.push({ ...span.attributes }) });
    try {
      const metrics = KbIndexingMetrics.begin({ contentType: "page", orgId: "org_a" });
      metrics.embedded(1);
      metrics.finish("indexed", { chunks: 1, reused: false });
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

  it("declares no attribute whose value could be a title, body, query or filename", () => {
    const declared = [...metricsSource.matchAll(/this\.attributes\["([^"]+)"\]/g)].map(
      (match) => match[1] as string,
    );
    expect(declared).toEqual(
      expect.arrayContaining(["kb.outcome", "kb.chunks", "kb.embedded", "kb.reused"]),
    );
    const allowed = new Set([
      "kb.content_type",
      "kb.outcome",
      "kb.duration_ms",
      "kb.chunks",
      "kb.embedded",
      "kb.reused",
      "org.id",
    ]);
    expect(declared.filter((key) => !allowed.has(key))).toEqual([]);
  });

  it("the emitter interpolates nothing into an attribute value", () => {
    expect(metricsSource).not.toMatch(/this\.attributes\[[^\]]+\]\s*=\s*`/);
    expect(metricsSource).not.toContain("contentText");
    expect(metricsSource).not.toContain("title");
  });
});

describe("the KB indexing span cannot be mis-bucketed into another seam's budget", () => {
  const seamLatency = read(SCRIPTS, "alert-seam-latency.mjs");
  const seamKey = firstCapture(seamLatency, /SEAM_ATTRIBUTE_KEY\s*=\s*"([^"]+)"/);

  it("(anti-vacuous) the seam attribute key is parsed out of the script", () => {
    expect(seamKey).not.toBeNull();
  });

  it("the seam alert skips a span whose seam is not a declared budget, and KB declares none", () => {
    expect(seamLatency).toContain("if (!(seamName in SEAM_BUDGETS)) continue;");
    expect(Object.keys(SEAM_BUDGETS)).not.toContain(KB_INDEXING_SPAN_NAME);
  });

  it("the span name has no space, so the p95 normaliser returns it unchanged", () => {
    expect(KB_INDEXING_SPAN_NAME).not.toContain(" ");
  });
});

describe("the KB indexing SLO names the numbers its alert actually fires on", () => {
  it("(anti-vacuous) the thresholds are parsed out of the alert script", () => {
    expect(firstCapture(alertSource, /const DEFAULT_FAULT_RATIO\s*=\s*([0-9.]+);/)).not.toBeNull();
    expect(firstCapture(alertSource, /const MIN_FAULTS\s*=\s*(\d+);/)).not.toBeNull();
  });

  it("matches the ratio and the floor the script defaults to", () => {
    const ratio = firstCapture(alertSource, /const DEFAULT_FAULT_RATIO\s*=\s*([0-9.]+);/);
    const floor = firstCapture(alertSource, /const MIN_FAULTS\s*=\s*(\d+);/);
    expect(Number(ratio)).toBe(KB_INDEXING_MAX_FAULT_RATIO);
    expect(Number(floor)).toBe(KB_INDEXING_MIN_FAULTS);
    if (KB_INDEXING_SLO.indicator.kind !== "outcome-rate") throw new Error("wrong indicator kind");
    expect(KB_INDEXING_SLO.indicator.maxFaultRatio).toBe(Number(ratio));
    expect(KB_INDEXING_SLO.indicator.minFaults).toBe(Number(floor));
    expect(KB_INDEXING_SLO.indicator.spanName).toBe(KB_INDEXING_SPAN_NAME);
    expect([...KB_INDEXING_SLO.indicator.faultOutcomes].sort()).toEqual(
      [...KB_INDEXING_FAULT_OUTCOMES].sort(),
    );
  });

  it("points at an alert id the dispatcher registers under the same owner", () => {
    const dispatch = read(SCRIPTS, "alert-dispatch.mjs");
    const entry = /"kb-indexing":\s*\{([^}]*)\}/.exec(dispatch)?.[1];
    expect(entry).toBeDefined();
    expect(firstCapture(entry ?? "", /owner:\s*"([^"]+)"/)).toBe(KB_INDEXING_SLO.owner);
    expect(firstCapture(entry ?? "", /runbookAnchor:\s*"([^"]+)"/)).toBe(
      KB_INDEXING_SLO.runbookAnchor,
    );
  });

  it("ships both npm entry points, because a script nobody can run is not an alert", () => {
    const pkg = JSON.parse(read(BACKEND_ROOT, "package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["alert:kb-indexing"]).toContain("alert-kb-indexing.mjs");
    expect(pkg.scripts["alert:kb-indexing:self-test"]).toContain("--self-test");
  });
});

const attachmentServiceSource = read(
  SRC,
  "modules",
  "kb",
  "retrieval",
  "kb-attachment-indexing.service.ts",
);

const DIRECTLY_FINISHED_OUTCOMES = [
  "reused",
  "acl_only",
  "skipped_no_content",
  "embedding_unavailable",
  "indexed",
];

function outcomesPassedToFinish(source: string): string[] {
  return [...source.matchAll(/metrics\.finish\(([^;]*?)\)\s*;/gs)].flatMap((call) =>
    [...(call[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((quoted) => quoted[1] ?? ""),
  );
}

describe("the emitter is wired at the indexing service's real decision points", () => {
  const finished = outcomesPassedToFinish(serviceSource);

  it("(anti-vacuous) the outcomes are read off the service's own finish calls", () => {
    expect(finished.length).toBeGreaterThanOrEqual(DIRECTLY_FINISHED_OUTCOMES.length);
    expect(outcomesPassedToFinish("return 0;")).toEqual([]);
  });

  it("finishes no outcome the frozen enum cannot produce, so a typo cannot reach the stream", () => {
    const declared: readonly string[] = KB_INDEXING_OUTCOMES;
    expect(finished.filter((outcome) => !declared.includes(outcome))).toEqual([]);
  });

  it.each(DIRECTLY_FINISHED_OUTCOMES)(
    "%s is finished on a branch the service already had, however that branch spells its choice",
    (outcome) => {
      expect(finished).toContain(outcome);
    },
  );

  it("classifies a thrown credit or provider failure rather than reporting a bare error", () => {
    expect(serviceSource).toContain("kbIndexingOutcomeForError(error)");
    expect(metricsSource).toContain("InsufficientAiCreditsException");
    expect(metricsSource).toContain("ServiceUnavailableException");
  });

  it("counts embedded chunks where the resumption helper already knows the number", () => {
    const resumption = read(SRC, "modules", "kb", "retrieval", "kb-embedding-resumption.ts");
    expect(resumption).toContain("metrics?.embedded(pending.length);");
  });
});

describe("the KB indexing emitter is also wired in the attachment indexing service", () => {
  function outcomesPassedToFinish(source: string): string[] {
    return [...source.matchAll(/metrics\.finish\(([^;]*?)\)\s*;/gs)].flatMap((call) =>
      [...(call[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((quoted) => quoted[1] ?? ""),
    );
  }

  const finished = outcomesPassedToFinish(attachmentServiceSource);

  it("(anti-vacuous) the attachment service has at least as many finish calls as directly-finished outcomes", () => {
    expect(finished.length).toBeGreaterThanOrEqual(DIRECTLY_FINISHED_OUTCOMES.length);
    expect(outcomesPassedToFinish("return 0;")).toEqual([]);
  });

  it("finishes no outcome the frozen indexing enum cannot produce", () => {
    const declared: readonly string[] = KB_INDEXING_OUTCOMES;
    expect(finished.filter((outcome) => !declared.includes(outcome))).toEqual([]);
  });

  it.each(["indexed", "reused", "acl_only", "skipped_no_content", "embedding_unavailable"])(
    "%s is finished on a branch the attachment service already had",
    (outcome) => {
      expect(finished).toContain(outcome);
    },
  );

  it("the attachment service imports KbIndexingMetrics", () => {
    expect(attachmentServiceSource).toContain("KbIndexingMetrics");
  });

  it("opens exactly one span per indexAttachment call (outer begin, not inside the measured helper)", () => {
    const beginCount = (attachmentServiceSource.match(/KbIndexingMetrics\.begin\(/g) ?? []).length;
    expect(beginCount).toBeGreaterThanOrEqual(1);
  });

  it("threads metrics into the embed helper so partial progress is counted", () => {
    expect(attachmentServiceSource).toContain("metrics,");
    expect(attachmentServiceSource).toContain("embedChunksWithResumption");
  });

  it("classifies a thrown credit or provider failure rather than reporting a bare error", () => {
    expect(attachmentServiceSource).toContain("kbIndexingOutcomeForError(error)");
  });
});
