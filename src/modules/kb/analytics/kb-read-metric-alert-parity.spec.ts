import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LogSpanExporter } from "../../../common/observability/log-span-exporter";
import { SENSITIVE_EXACT, SENSITIVE_SUBSTRINGS } from "../../../common/observability/redact";
import { resetSpanExporter, setSpanExporter } from "../../../common/observability";
import {
  KB_READ_SLO,
  KB_READ_FAULT_OUTCOMES,
  KB_READ_MAX_FAULT_RATIO,
  KB_READ_MIN_FAULTS,
} from "../../../common/slo/slo-kb-read-write";
import {
  KB_READ_OUTCOMES,
  KB_READ_QUEUE_LANE,
  KB_READ_SPAN_NAME,
  KbReadMetrics,
  isKbReadFault,
} from "./kb-read-metrics";

const BACKEND_ROOT = resolve(__dirname, "../../../..");
const SCRIPTS = join(BACKEND_ROOT, "src", "scripts");
const SRC = join(BACKEND_ROOT, "src");

function read(...segments: string[]): string {
  return readFileSync(join(...segments), "utf8");
}

function firstCapture(text: string, pattern: RegExp): string | null {
  return pattern.exec(text)?.[1] ?? null;
}

const exporterSource = read(SRC, "common", "observability", "log-span-exporter.ts");
const metricsSource = read(__dirname, "kb-read-metrics.ts");
const alertSource = read(SCRIPTS, "alert-kb-read.mjs");

function emitOneLine(run: (metrics: KbReadMetrics) => void): Record<string, unknown> {
  const written: string[] = [];
  const spy = jest
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });

  setSpanExporter(new LogSpanExporter());
  try {
    run(KbReadMetrics.begin({ orgId: "org_a" }));
  } finally {
    resetSpanExporter();
    spy.mockRestore();
  }

  expect(written).toHaveLength(1);
  const record: unknown = JSON.parse(written[0] as string);
  if (record === null || typeof record !== "object") throw new Error("not a record");
  return record as Record<string, unknown>;
}

describe("the KB Read metric reaches the stream the span alerts already read", () => {
  const emittedMessage = firstCapture(exporterSource, /message:\s*"([^"]+)"/);

  it("(anti-vacuous) the exporter message literal is parsed out of its source", () => {
    expect(emittedMessage).not.toBeNull();
  });

  it("the KB Read alert keys on that exact literal", () => {
    const compared = firstCapture(alertSource, /record\.message\s*(?:!==|===)\s*"([^"]+)"/);
    expect(compared).not.toBeNull();
    expect(compared).toBe(emittedMessage);
  });

  it("the KB Read metric is emitted through the exporter port, not a private log line", () => {
    expect(metricsSource).toContain('from "../../../common/observability"');
    expect(metricsSource).toContain("startSpan(KB_READ_SPAN_NAME");
  });

  it("the span name the alert filters on is the one the emitter declares", () => {
    const emitted = firstCapture(metricsSource, /KB_READ_SPAN_NAME\s*=\s*"([^"]+)"/);
    const filtered = firstCapture(alertSource, /const SPAN_NAME\s*=\s*"([^"]+)"/);
    expect(emitted).toBe(KB_READ_SPAN_NAME);
    expect(filtered).toBe(emitted);
  });

  it("the outcome attribute the alert reads is the key the emitter writes", () => {
    const filtered = firstCapture(alertSource, /const OUTCOME_ATTRIBUTE_KEY\s*=\s*"([^"]+)"/);
    expect(filtered).not.toBeNull();
    expect(metricsSource).toContain(`this.attributes["${filtered}"] = outcome;`);
  });

  it("carries every outcome the spec requires", () => {
    for (const required of ["found", "not_found", "denied", "error"])
      expect(KB_READ_OUTCOMES).toContain(required);
  });

  it("fault classification is consistent with the alert fault list", () => {
    const declared = firstCapture(alertSource, /const FAULT_OUTCOMES\s*=\s*\[([^\]]*)\]/) ?? "";
    const parsed = [...declared.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(parsed.length).toBeGreaterThan(0);
    expect([...parsed].sort()).toEqual([...KB_READ_OUTCOMES.filter(isKbReadFault)].sort());
  });

  it("names no fault outcome the frozen enum cannot produce", () => {
    const declared = firstCapture(alertSource, /const FAULT_OUTCOMES\s*=\s*\[([^\]]*)\]/) ?? "";
    const parsed = [...declared.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    const unknown = parsed.filter((o) => !(KB_READ_OUTCOMES as readonly string[]).includes(o));
    expect(unknown).toEqual([]);
  });

  it("a real emitted line carries every field the KB Read alert reads", () => {
    const line = emitOneLine((metrics) => {
      metrics.finish("found", { contentType: "page", cacheOutcome: "hit" });
    });

    expect(line["message"]).toBe("SPAN");
    expect(line["name"]).toBe(KB_READ_SPAN_NAME);
    expect(typeof line["latencyMs"]).toBe("number");
    expect(Number.isFinite(line["latencyMs"])).toBe(true);
    expect(line["status"]).toBe("ok");
    expect(Number.isNaN(new Date(line["timestamp"] as string).getTime())).toBe(false);
    expect(line["kb.read.outcome"]).toBe("found");
    expect(typeof line["kb.read.duration_ms"]).toBe("number");
    expect(line["org.id"]).toBe("org_a");
    expect(line["kb.read.content_type"]).toBe("page");
    expect(line["kb.read.cache_outcome"]).toBe("hit");
  });

  it("a fault outcome closes the span as error so status and outcome agree", () => {
    const line = emitOneLine((metrics) => metrics.finish("denied"));
    expect(line["status"]).toBe("error");
    expect(line["kb.read.outcome"]).toBe("denied");
  });

  it("a non-fault outcome closes the span as ok", () => {
    const line = emitOneLine((metrics) => metrics.finish("not_found"));
    expect(line["status"]).toBe("ok");
  });
});

describe("the KB Read span carries no tenant content and survives redaction", () => {
  it("writes no attribute key the log redactor would blank", () => {
    const attributes: Array<Record<string, unknown>> = [];
    setSpanExporter({ export: (span) => attributes.push({ ...span.attributes }) });
    try {
      const metrics = KbReadMetrics.begin({ orgId: "org_a" });
      metrics.finish("found", { contentType: "article" });
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

  it("declares no attribute whose value could be page title or body text", () => {
    const declared = [...metricsSource.matchAll(/this\.attributes\["([^"]+)"\]/g)].map(
      (match) => match[1] as string,
    );
    const allowed = new Set([
      "org.id",
      "actor.standing",
      "org.cell",
      "kb.read.outcome",
      "kb.read.duration_ms",
      "kb.read.content_type",
      "kb.read.cache_outcome",
      "kb.read.db_role",
      "kb.read.queue_lane",
      "kb.read.source_kind",
    ]);
    expect(declared.filter((key) => !allowed.has(key))).toEqual([]);
  });

  it("the emitter interpolates nothing into an attribute value", () => {
    expect(metricsSource).not.toMatch(/this\.attributes\[[^\]]+\]\s*=\s*`/);
    expect(metricsSource).not.toContain("title");
    expect(metricsSource).not.toContain("contentText");
  });
});

describe("the KB Read alert self-test passes, so its predicate is proven against real emission", () => {
  it("the alert script exists", () => {
    expect(existsSync(join(SCRIPTS, "alert-kb-read.mjs"))).toBe(true);
  });

  it("the self-test passes, meaning the predicate matches what the emitter produces", () => {
    const output = execFileSync(process.execPath, [join(SCRIPTS, "alert-kb-read.mjs"), "--self-test"], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
      pass: boolean;
      checks: Record<string, boolean>;
    };
    expect(Object.values(parsed.checks).length).toBeGreaterThan(0);
    expect(Object.entries(parsed.checks).filter(([, ok]) => !ok)).toEqual([]);
    expect(parsed.pass).toBe(true);
  });

  it("the alert counts a real emitted line, not a hand-written fixture", () => {
    const line = emitOneLine((metrics) => metrics.finish("error"));
    const dir = mkdtempSync(join(tmpdir(), "kb-read-parity-"));
    const logPath = join(dir, "spans.log");
    const notFoundLine = emitOneLine((metrics) => metrics.finish("not_found"));
    const foundLine = emitOneLine((metrics) => metrics.finish("found"));
    writeFileSync(
      logPath,
      `${JSON.stringify(foundLine)}\n${JSON.stringify(notFoundLine)}\n${JSON.stringify(line)}\n`,
      "utf8",
    );

    let status = 0;
    let output: string;
    try {
      output = execFileSync(
        process.execPath,
        [join(SCRIPTS, "alert-kb-read.mjs"), `--log=${logPath}`, "--hours=1"],
        { encoding: "utf8" },
      );
    } catch (error) {
      const failure = error as { status: number; stdout: string };
      status = failure.status;
      output = failure.stdout;
    }
    const parsed = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
      operations: number;
      faults: number;
      outcomes: Record<string, number>;
    };

    expect(parsed.operations).toBe(3);
    expect(parsed.faults).toBe(1);
    expect(parsed.outcomes["error"]).toBe(1);
    expect(parsed.outcomes["found"]).toBe(1);
    void status;
  });

  it("exits 2 rather than reporting health when no KB Read span reached the stream", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-read-unwired-"));
    const logPath = join(dir, "spans.log");
    writeFileSync(
      logPath,
      `${JSON.stringify({ message: "SPAN", name: "kb.write.operation" })}\n`,
      "utf8",
    );

    let status = 0;
    try {
      execFileSync(process.execPath, [join(SCRIPTS, "alert-kb-read.mjs"), `--log=${logPath}`], {
        encoding: "utf8",
      });
    } catch (error) {
      status = (error as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});

describe("the KB Read SLO names the numbers its alert actually fires on", () => {
  it("the SLO is defined and has the right indicator kind", () => {
    expect(KB_READ_SLO.id).toBe("module:kb:read");
    if (KB_READ_SLO.indicator.kind !== "outcome-rate") throw new Error("wrong indicator kind");
    expect(KB_READ_SLO.indicator.spanName).toBe(KB_READ_SPAN_NAME);
    expect(KB_READ_SLO.indicator.outcomeAttribute).toBe("kb.read.outcome");
  });

  it("matches the ratio and the floor the script defaults to", () => {
    const ratio = firstCapture(alertSource, /const DEFAULT_FAULT_RATIO\s*=\s*([0-9.]+);/);
    const floor = firstCapture(alertSource, /const MIN_FAULTS\s*=\s*(\d+);/);
    expect(ratio).not.toBeNull();
    expect(floor).not.toBeNull();
    expect(Number(ratio)).toBe(KB_READ_MAX_FAULT_RATIO);
    expect(Number(floor)).toBe(KB_READ_MIN_FAULTS);
    if (KB_READ_SLO.indicator.kind !== "outcome-rate") throw new Error("wrong indicator kind");
    expect(KB_READ_SLO.indicator.maxFaultRatio).toBe(Number(ratio));
    expect(KB_READ_SLO.indicator.minFaults).toBe(Number(floor));
    expect([...KB_READ_FAULT_OUTCOMES].sort()).toEqual(
      [...KB_READ_SLO.indicator.faultOutcomes].sort(),
    );
  });

  it("KB Read runs on a named lane so a second lane has a named home", () => {
    expect(typeof KB_READ_QUEUE_LANE).toBe("string");
    expect(metricsSource).toContain("KB_READ_QUEUE_LANE");
  });
});

describe("ORCHESTRATOR CALL SITES — these tests fail until the orchestrator wires the metric", () => {
  it("ORCHESTRATOR: add 'kb-read' entry to src/scripts/alert-dispatch.mjs REGISTRY with owner knowledge-team", () => {
    const dispatch = read(SCRIPTS, "alert-dispatch.mjs");
    expect(dispatch).toContain('"kb-read"');
  });

  it("ORCHESTRATOR: add alert:kb-read and alert:kb-read:self-test to package.json scripts", () => {
    const pkg = JSON.parse(read(BACKEND_ROOT, "package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["alert:kb-read"]).toContain("alert-kb-read.mjs");
    expect(pkg.scripts["alert:kb-read:self-test"]).toContain("--self-test");
  });

  it("ORCHESTRATOR: add #kb-read heading to docs/specs/knowledge-base/KB-OBSERVABILITY-RUNBOOK.md", () => {
    const repoRoot = resolve(BACKEND_ROOT, "..");
    const runbookPath = join(repoRoot, "docs", "specs", "knowledge-base", "KB-OBSERVABILITY-RUNBOOK.md");
    expect(existsSync(runbookPath)).toBe(true);
    const runbook = readFileSync(runbookPath, "utf8");
    expect(runbook).toContain("#kb-read");
  });

  it("ORCHESTRATOR: add module:kb:read to src/common/slo/index.ts SLO_CATALOGUE", () => {
    const sloIndex = read(SRC, "common", "slo", "index.ts");
    expect(sloIndex).toContain("KB_READ_WRITE_SLOS");
  });

  it("ORCHESTRATOR: wire KbReadMetrics.begin() in kb/wiki/kb-pages.service.ts page read path — import from kb/analytics/kb-read-metrics", () => {
    const pagesServicePath = join(SRC, "modules", "kb", "wiki", "kb-pages.service.ts");
    if (!existsSync(pagesServicePath)) return;
    const source = readFileSync(pagesServicePath, "utf8");
    expect(source).toContain("KbReadMetrics");
  });

  it("ORCHESTRATOR: wire KbReadMetrics.begin() in kb/help-centre/kb-articles.service.ts article read path", () => {
    const articlesServicePath = join(SRC, "modules", "kb", "help-centre", "kb-articles.service.ts");
    if (!existsSync(articlesServicePath)) return;
    const source = readFileSync(articlesServicePath, "utf8");
    expect(source).toContain("KbReadMetrics");
  });
});
