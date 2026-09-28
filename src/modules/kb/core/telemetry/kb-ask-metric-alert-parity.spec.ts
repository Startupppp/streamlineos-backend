import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LogSpanExporter } from "../../../../common/observability/log-span-exporter";
import { SENSITIVE_EXACT, SENSITIVE_SUBSTRINGS } from "../../../../common/observability/redact";
import { resetSpanExporter, setSpanExporter } from "../../../../common/observability";
import {
  KB_ASK_SLO,
  KB_ASK_FAULT_OUTCOMES,
  KB_ASK_MAX_FAULT_RATIO,
  KB_ASK_MIN_FAULTS,
} from "../../../../common/slo";
import {
  KB_ASK_OUTCOMES,
  KB_ASK_QUEUE_LANE,
  KB_ASK_SPAN_NAME,
  KbAskMetrics,
  isKbAskFault,
} from "./kb-ask-metrics";

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
const metricsSource = read(__dirname, "kb-ask-metrics.ts");
const alertSource = read(SCRIPTS, "alert-kb-ask.mjs");
const askServiceSource = read(SRC, "modules", "kb", "retrieval", "kb-ask.service.ts");

function emitOneLine(run: (metrics: KbAskMetrics) => void): Record<string, unknown> {
  const written: string[] = [];
  const spy = jest
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });

  setSpanExporter(new LogSpanExporter());
  try {
    run(KbAskMetrics.begin({ orgId: "org_a" }));
  } finally {
    resetSpanExporter();
    spy.mockRestore();
  }

  expect(written).toHaveLength(1);
  const record: unknown = JSON.parse(written[0] as string);
  if (record === null || typeof record !== "object") throw new Error("not a record");
  return record as Record<string, unknown>;
}

describe("the KB Ask metric reaches the stream the span alerts already read", () => {
  const emittedMessage = firstCapture(exporterSource, /message:\s*"([^"]+)"/);

  it("(anti-vacuous) the exporter's message literal is parsed out of its source", () => {
    expect(emittedMessage).not.toBeNull();
  });

  it("the KB Ask alert keys on that exact literal", () => {
    const compared = firstCapture(alertSource, /record\.message\s*(?:!==|===)\s*"([^"]+)"/);
    expect(compared).not.toBeNull();
    expect(compared).toBe(emittedMessage);
  });

  it("the KB Ask metric is emitted through the exporter's port, not a private log line", () => {
    expect(metricsSource).toContain('from "../../../../common/observability"');
    expect(metricsSource).toContain("startSpan(KB_ASK_SPAN_NAME");
  });

  it("the span name the alert filters on is the one the emitter declares", () => {
    const emitted = firstCapture(metricsSource, /KB_ASK_SPAN_NAME\s*=\s*"([^"]+)"/);
    const filtered = firstCapture(alertSource, /const SPAN_NAME\s*=\s*"([^"]+)"/);
    expect(emitted).toBe(KB_ASK_SPAN_NAME);
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
      [...KB_ASK_OUTCOMES.filter(isKbAskFault)].sort(),
    );
  });

  it("names no fault outcome the frozen enum cannot produce", () => {
    const declared = firstCapture(alertSource, /const FAULT_OUTCOMES\s*=\s*\[([^\]]*)\]/) ?? "";
    const parsed = [...declared.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    const unknown = parsed.filter(
      (outcome) => !(KB_ASK_OUTCOMES as readonly string[]).includes(outcome),
    );
    expect(unknown).toEqual([]);
  });

  it("carries every outcome the spec requires", () => {
    for (const required of [
      "answered",
      "no_context",
      "degraded",
      "credits_exhausted",
      "provider_unavailable",
      "error",
    ])
      expect(KB_ASK_OUTCOMES).toContain(required);
  });

  it("a real emitted line carries every field the KB Ask alert reads", () => {
    const line = emitOneLine((metrics) => {
      metrics.finish("answered", { citations: 3, candidates: 5 });
    });

    expect(line["message"]).toBe("SPAN");
    expect(line["name"]).toBe(KB_ASK_SPAN_NAME);
    expect(typeof line["latencyMs"]).toBe("number");
    expect(Number.isFinite(line["latencyMs"])).toBe(true);
    expect(line["status"]).toBe("ok");
    expect(Number.isNaN(new Date(line["timestamp"] as string).getTime())).toBe(false);
    expect(line["kb.ask.outcome"]).toBe("answered");
    expect(line["kb.ask.citations"]).toBe(3);
    expect(line["kb.ask.candidates"]).toBe(5);
    expect(line["kb.ask.degraded"]).toBe(false);
    expect(typeof line["kb.ask.duration_ms"]).toBe("number");
    expect(line["org.id"]).toBe("org_a");
  });

  it("a fault outcome closes the span as an error so the status and the outcome agree", () => {
    const line = emitOneLine((metrics) => metrics.finish("credits_exhausted"));
    expect(line["status"]).toBe("error");
    expect(line["kb.ask.outcome"]).toBe("credits_exhausted");
  });

  it("a non-fault outcome closes the span as ok", () => {
    const line = emitOneLine((metrics) => metrics.finish("no_context"));
    expect(line["status"]).toBe("ok");
  });

  it("the alert counts a line the emitter actually produced, not a hand-written fixture", () => {
    const line = emitOneLine((metrics) =>
      metrics.finish("answered", { citations: 2, candidates: 4 }),
    );
    const dir = mkdtempSync(join(tmpdir(), "kb-ask-parity-"));
    const logPath = join(dir, "spans.log");
    writeFileSync(logPath, `${JSON.stringify(line)}\n`, "utf8");

    const output = execFileSync(
      process.execPath,
      [join(SCRIPTS, "alert-kb-ask.mjs"), `--log=${logPath}`, "--hours=1"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
      fired: boolean;
      operations: number;
      outcomes: Record<string, number>;
    };

    expect(parsed.operations).toBe(1);
    expect(parsed.outcomes["answered"]).toBe(1);
    expect(parsed.fired).toBe(false);
  });

  it("exits 2 rather than reporting health when no KB Ask span reached the stream", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-ask-unwired-"));
    const logPath = join(dir, "spans.log");
    writeFileSync(
      logPath,
      `${JSON.stringify({ message: "SPAN", name: "kb.indexing.operation" })}\n`,
      "utf8",
    );

    let status = 0;
    try {
      execFileSync(process.execPath, [join(SCRIPTS, "alert-kb-ask.mjs"), `--log=${logPath}`], {
        encoding: "utf8",
      });
    } catch (error) {
      status = (error as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});

describe("the KB Ask span carries no tenant content and survives redaction", () => {
  it("writes no attribute key the log redactor would blank", () => {
    const attributes: Array<Record<string, unknown>> = [];
    setSpanExporter({ export: (span) => attributes.push({ ...span.attributes }) });
    try {
      const metrics = KbAskMetrics.begin({ orgId: "org_a" });
      metrics.finish("answered", { citations: 1, candidates: 3 });
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

  it("declares no attribute whose value could be a question, answer, or body text", () => {
    const declared = [...metricsSource.matchAll(/this\.attributes\["([^"]+)"\]/g)].map(
      (match) => match[1] as string,
    );
    expect(declared).toEqual(
      expect.arrayContaining(["kb.ask.outcome", "kb.ask.citations", "kb.ask.candidates"]),
    );
    const allowed = new Set([
      "org.id",
      "actor.standing",
      "org.cell",
      "kb.ask.outcome",
      "kb.ask.duration_ms",
      "kb.ask.citations",
      "kb.ask.candidates",
      "kb.ask.degraded",
      "kb.ask.retrieval_latency_ms",
      "kb.ask.is_no_answer",
      "kb.ask.queue_lane",
      "kb.ask.source_kind",
      "kb.ask.cache_outcome",
      "kb.ask.db_role",
    ]);
    expect(declared.filter((key) => !allowed.has(key))).toEqual([]);
  });

  it("the emitter interpolates nothing into an attribute value", () => {
    expect(metricsSource).not.toMatch(/this\.attributes\[[^\]]+\]\s*=\s*`/);
    expect(metricsSource).not.toContain("contentText");
    expect(metricsSource).not.toContain("title");
  });

  it("(anti-vacuous bite) the runtime redaction gate catches a hypothetical prompt-text attribute added to the span", () => {
    const attributes: Record<string, string | number | boolean> = {};
    attributes["kb.ask.retrieval_prompt"] = "what is the onboarding process";
    const normalise = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const blanked = Object.keys(attributes).filter(
      (key) =>
        SENSITIVE_EXACT.has(normalise(key)) ||
        SENSITIVE_SUBSTRINGS.some((needle) => normalise(key).includes(needle)),
    );
    expect(blanked).toContain("kb.ask.retrieval_prompt");
  });
});

describe("the KB Ask SLO names the numbers its alert actually fires on", () => {
  it("(anti-vacuous) the thresholds are parsed out of the alert script", () => {
    expect(firstCapture(alertSource, /const DEFAULT_FAULT_RATIO\s*=\s*([0-9.]+);/)).not.toBeNull();
    expect(firstCapture(alertSource, /const MIN_FAULTS\s*=\s*(\d+);/)).not.toBeNull();
  });

  it("matches the ratio and the floor the script defaults to", () => {
    const ratio = firstCapture(alertSource, /const DEFAULT_FAULT_RATIO\s*=\s*([0-9.]+);/);
    const floor = firstCapture(alertSource, /const MIN_FAULTS\s*=\s*(\d+);/);
    expect(Number(ratio)).toBe(KB_ASK_MAX_FAULT_RATIO);
    expect(Number(floor)).toBe(KB_ASK_MIN_FAULTS);
    if (KB_ASK_SLO.indicator.kind !== "outcome-rate") throw new Error("wrong indicator kind");
    expect(KB_ASK_SLO.indicator.maxFaultRatio).toBe(Number(ratio));
    expect(KB_ASK_SLO.indicator.minFaults).toBe(Number(floor));
    expect(KB_ASK_SLO.indicator.spanName).toBe(KB_ASK_SPAN_NAME);
    expect([...KB_ASK_SLO.indicator.faultOutcomes].sort()).toEqual(
      [...KB_ASK_FAULT_OUTCOMES].sort(),
    );
  });

  it("points at an alert id the dispatcher registers under the same owner", () => {
    const dispatch = read(SCRIPTS, "alert-dispatch.mjs");
    const entry = /"kb-ask":\s*\{([^}]*)\}/.exec(dispatch)?.[1];
    expect(entry).toBeDefined();
    expect(firstCapture(entry ?? "", /owner:\s*"([^"]+)"/)).toBe(KB_ASK_SLO.owner);
    expect(firstCapture(entry ?? "", /runbookAnchor:\s*"([^"]+)"/)).toBe(
      KB_ASK_SLO.runbookAnchor,
    );
  });

  it("ships both npm entry points, because a script nobody can run is not an alert", () => {
    const pkg = JSON.parse(read(BACKEND_ROOT, "package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["alert:kb-ask"]).toContain("alert-kb-ask.mjs");
    expect(pkg.scripts["alert:kb-ask:self-test"]).toContain("--self-test");
  });
});

describe("the KB Ask emitter is wired at the ask service's real decision points", () => {
  function outcomesPassedToFinish(source: string): string[] {
    return [...source.matchAll(/metrics\.finish\(([^;]*?)\)\s*;/gs)].flatMap((call) =>
      [...(call[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((quoted) => quoted[1] ?? ""),
    );
  }

  const finished = outcomesPassedToFinish(askServiceSource);

  it("(anti-vacuous) outcomes are parsed off real finish calls", () => {
    expect(finished.length).toBeGreaterThan(0);
    expect(outcomesPassedToFinish("return;")).toEqual([]);
  });

  it("finishes no outcome the frozen enum cannot produce", () => {
    const declared: readonly string[] = KB_ASK_OUTCOMES;
    expect(finished.filter((outcome) => !declared.includes(outcome))).toEqual([]);
  });

  it("covers answered, no_context, credits_exhausted, provider_unavailable and error branches", () => {
    for (const outcome of [
      "answered",
      "no_context",
      "credits_exhausted",
      "provider_unavailable",
      "error",
    ])
      expect(finished).toContain(outcome);
  });

  it("classifies a credit or provider failure rather than reporting a bare error", () => {
    expect(askServiceSource).toContain("credits_exhausted");
    expect(askServiceSource).toContain("provider_unavailable");
    expect(metricsSource).toContain("InsufficientAiCreditsException");
  });
});

describe("the KB Ask emitter supplies all six observability dimensions", () => {
  it("wires actorStanding from the user context so the actor-standing dimension emits", () => {
    expect(askServiceSource).toMatch(/actorStanding\s*:\s*user\.isOrgOwner/);
  });

  it("wires orgCell from the cell placement constant so the tenant-bucket dimension emits", () => {
    expect(askServiceSource).toContain("orgCell");
    expect(askServiceSource).toContain("PROCESS_CELL_ID");
  });

  it("passes cacheOutcome to finish so the cache-outcome dimension emits", () => {
    expect(askServiceSource).toContain("cacheOutcome");
  });

  it("passes dbRole to finish so the primary-replica dimension emits", () => {
    expect(askServiceSource).toContain("dbRole");
  });

  it("passes queueLane to finish so the queue-lane dimension emits", () => {
    expect(askServiceSource).toContain("queueLane");
  });

  it("KB Ask runs on a single named lane KB_ASK_QUEUE_LANE so a second lane has a named home", () => {
    expect(typeof KB_ASK_QUEUE_LANE).toBe("string");
    expect(askServiceSource).toContain("KB_ASK_QUEUE_LANE");
    expect(askServiceSource).not.toMatch(/const queueLane\s*=\s*["']/);
  });

  it("passes sourceKind to finish so the source-kind dimension emits", () => {
    expect(askServiceSource).toContain("sourceKind");
  });
});
