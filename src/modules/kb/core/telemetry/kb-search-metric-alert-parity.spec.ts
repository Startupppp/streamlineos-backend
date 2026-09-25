import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SENSITIVE_EXACT, SENSITIVE_SUBSTRINGS } from "../../../../common/observability/redact";
import { resetSpanExporter, setSpanExporter } from "../../../../common/observability";
import { LogSpanExporter } from "../../../../common/observability/log-span-exporter";
import { SLO_CATALOGUE } from "../../../../common/slo";
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
      "actor.standing",
      "org.cell",
      "kb.search.outcome",
      "kb.search.duration_ms",
      "kb.search.results",
      "kb.search.source_kind",
      "kb.search.cache_outcome",
      "kb.search.db_role",
      "kb.search.queue_lane",
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

describe("the KB Search emitter supplies all observability dimensions", () => {
  it("wires actorStanding from the user context so the actor-standing dimension emits", () => {
    expect(searchServiceSource).toMatch(/actorStanding\s*:\s*user\.isOrgOwner/);
  });

  it("wires orgCell from the cell placement constant so the tenant-bucket dimension emits", () => {
    expect(searchServiceSource).toContain("orgCell");
    expect(searchServiceSource).toContain("PROCESS_CELL_ID");
  });

  it("passes cacheOutcome to finish so the cache-outcome dimension emits", () => {
    expect(searchServiceSource).toContain("cacheOutcome");
  });

  it("passes dbRole to finish so the primary-replica dimension emits", () => {
    expect(searchServiceSource).toContain("dbRole");
  });

  it("passes sourceKind to finish so the source-kind dimension emits", () => {
    expect(searchServiceSource).toContain("sourceKind");
  });
});

describe("KB Search denial and not-found anomalies reach an operator", () => {
  const alertPath = join(SCRIPTS, "alert-kb-search.mjs");

  it("ships an alert script, because an emitted span nothing reads is not observability", () => {
    expect(existsSync(alertPath)).toBe(true);
  });

  it("reads the span name and outcome attribute the emitter actually writes", () => {
    const alertSource = readFileSync(alertPath, "utf8");
    expect(firstCapture(alertSource, /const SPAN_NAME\s*=\s*"([^"]+)"/)).toBe(KB_SEARCH_SPAN_NAME);
    expect(firstCapture(alertSource, /const OUTCOME_ATTRIBUTE_KEY\s*=\s*"([^"]+)"/)).toBe(
      "kb.search.outcome",
    );
  });

  it("names no fault or anomaly outcome the frozen enum cannot produce", () => {
    const alertSource = readFileSync(alertPath, "utf8");
    const declared = firstCapture(alertSource, /const FAULT_OUTCOMES\s*=\s*\[([^\]]*)\]/) ?? "";
    const parsed = [...declared.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(parsed.length).toBeGreaterThan(0);
    const known: readonly string[] = KB_SEARCH_OUTCOMES;
    expect(parsed.filter((outcome) => !known.includes(outcome))).toEqual([]);
    expect(firstCapture(alertSource, /const DENIED_OUTCOME\s*=\s*"([^"]+)"/)).toBe("denied");
    expect(firstCapture(alertSource, /const NOT_FOUND_OUTCOME\s*=\s*"([^"]+)"/)).toBe("not_found");
  });

  it("the alert counts a line the emitter actually produced, not a hand-written fixture", () => {
    const line = emitOneLine((metrics) => metrics.finish("denied"));
    const dir = mkdtempSync(join(tmpdir(), "kb-search-parity-"));
    const logPath = join(dir, "spans.log");
    writeFileSync(logPath, `${JSON.stringify(line)}\n`, "utf8");

    const output = execFileSync(
      process.execPath,
      [alertPath, `--log=${logPath}`, "--hours=1"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
      operations: number;
      deniedCount: number;
      outcomes: Record<string, number>;
    };

    expect(parsed.operations).toBe(1);
    expect(parsed.deniedCount).toBe(1);
    expect(parsed.outcomes["denied"]).toBe(1);
  });

  it("a denial spike pages even when no request errored", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-search-denial-"));
    const logPath = join(dir, "spans.log");
    const lines: string[] = [];
    for (let i = 0; i < 6; i += 1)
      lines.push(JSON.stringify(emitOneLine((metrics) => metrics.finish("found", { results: 3 }))));
    for (let i = 0; i < 14; i += 1)
      lines.push(JSON.stringify(emitOneLine((metrics) => metrics.finish("denied"))));
    writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");

    let status = 0;
    let output: string;
    try {
      output = execFileSync(process.execPath, [alertPath, `--log=${logPath}`, "--hours=1"], {
        encoding: "utf8",
      });
    } catch (error) {
      const failure = error as { status: number; stdout: string };
      status = failure.status;
      output = failure.stdout;
    }
    const parsed = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
      fired: boolean;
      faults: number;
      deniedBreached: boolean;
    };

    expect(parsed.faults).toBe(0);
    expect(parsed.deniedBreached).toBe(true);
    expect(parsed.fired).toBe(true);
    expect(status).toBe(1);
  });

  it("exits 2 rather than reporting health when no KB Search span reached the stream", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-search-unwired-"));
    const logPath = join(dir, "spans.log");
    writeFileSync(
      logPath,
      `${JSON.stringify({ message: "SPAN", name: "kb.ask.operation" })}\n`,
      "utf8",
    );

    let status = 0;
    try {
      execFileSync(process.execPath, [alertPath, `--log=${logPath}`], { encoding: "utf8" });
    } catch (error) {
      status = (error as { status: number }).status;
    }
    expect(status).toBe(2);
  });

  it("its self-test passes, so the predicate is proven against fixtures the emitter shapes", () => {
    const output = execFileSync(process.execPath, [alertPath, "--self-test"], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
      pass: boolean;
      checks: Record<string, boolean>;
    };
    expect(Object.keys(parsed.checks).length).toBeGreaterThanOrEqual(10);
    expect(Object.entries(parsed.checks).filter(([, ok]) => !ok)).toEqual([]);
    expect(parsed.pass).toBe(true);
  });
});

describe("the KB Search SLO names the numbers its alert actually fires on", () => {
  const slo = SLO_CATALOGUE.find((entry) => entry.id === "module:kb:search");

  it("is registered in the SLO catalogue", () => {
    expect(slo).toBeDefined();
  });

  it("matches the ratio and the floor the script defaults to", () => {
    const alertSource = readFileSync(join(SCRIPTS, "alert-kb-search.mjs"), "utf8");
    const ratio = firstCapture(alertSource, /const DEFAULT_FAULT_RATIO\s*=\s*([0-9.]+);/);
    const floor = firstCapture(alertSource, /const MIN_FAULTS\s*=\s*(\d+);/);
    expect(ratio).not.toBeNull();
    expect(floor).not.toBeNull();
    if (slo === undefined) throw new Error("module:kb:search is not in the catalogue");
    if (slo.indicator.kind !== "outcome-rate") throw new Error("wrong indicator kind");
    expect(slo.indicator.maxFaultRatio).toBe(Number(ratio));
    expect(slo.indicator.minFaults).toBe(Number(floor));
    expect(slo.indicator.spanName).toBe(KB_SEARCH_SPAN_NAME);
    expect(slo.indicator.outcomeAttribute).toBe("kb.search.outcome");
  });

  it("points at an alert id the dispatcher registers under the same owner", () => {
    const dispatch = read(SCRIPTS, "alert-dispatch.mjs");
    const entry = /"kb-search":\s*\{([^}]*)\}/.exec(dispatch)?.[1];
    expect(entry).toBeDefined();
    if (slo === undefined) throw new Error("module:kb:search is not in the catalogue");
    expect(firstCapture(entry ?? "", /owner:\s*"([^"]+)"/)).toBe(slo.owner);
    expect(firstCapture(entry ?? "", /runbookAnchor:\s*"([^"]+)"/)).toBe(slo.runbookAnchor);
  });

  it("ships both npm entry points, because a script nobody can run is not an alert", () => {
    const pkg = JSON.parse(read(BACKEND_ROOT, "package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["alert:kb-search"]).toContain("alert-kb-search.mjs");
    expect(pkg.scripts["alert:kb-search:self-test"]).toContain("--self-test");
  });
});
