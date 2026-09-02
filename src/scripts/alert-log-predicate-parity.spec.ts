import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * An alert whose predicate matches text no log line produces is silently inert:
 * it never fires, it never errors, and its self-test passes because the self-test
 * feeds it the fixture the predicate was written against rather than the string
 * the application emits. This repository has shipped that shape.
 *
 * So each predicate is read out of the alert script and matched against the
 * source of the line that is supposed to satisfy it. Both sides are parsed —
 * hard-coding either one would make this the same kind of self-affirming
 * assertion it exists to catch.
 */
const BACKEND_ROOT = resolve(__dirname, "../..");
const SCRIPTS = join(BACKEND_ROOT, "src", "scripts");
const SRC = join(BACKEND_ROOT, "src");

function read(...segments: string[]): string {
  return readFileSync(join(...segments), "utf8");
}

function firstCapture(text: string, pattern: RegExp): string | null {
  return pattern.exec(text)?.[1] ?? null;
}

describe("SPAN lines — the message the p95, seam-latency and pool alerts key on", () => {
  const exporter = read(SRC, "common", "observability", "log-span-exporter.ts");

  const emittedMessage = firstCapture(exporter, /message:\s*"([^"]+)"/);

  it("(anti-vacuous) the exporter's message literal is parsed, not assumed", () => {
    expect(emittedMessage).not.toBeNull();
  });

  it.each(["alert-p95.mjs", "alert-seam-latency.mjs", "alert-pool-saturation.mjs"])(
    "%s compares against the literal the exporter writes",
    (script) => {
      const text = read(SCRIPTS, script);
      const compared = firstCapture(text, /record\.message\s*(?:!==|===)\s*"([^"]+)"/);
      expect(compared).not.toBeNull();
      expect(compared).toBe(emittedMessage);
    },
  );

  it("the exporter puts the span attributes at the top level, where the predicates read `seam`", () => {
    expect(exporter).toContain("...redactAttributes(span.attributes)");
  });
});

describe("pool saturation — a prose fragment, the most fragile predicate shape there is", () => {
  const script = read(SCRIPTS, "alert-pool-saturation.mjs");
  const telemetry = read(SRC, "db", "pool-telemetry.ts");

  const fragment = firstCapture(script, /SATURATION_MESSAGE_FRAGMENT\s*=\s*"([^"]+)"/);
  const seam = firstCapture(script, /POOL_WAIT_SEAM\s*=\s*"([^"]+)"/);

  it("(anti-vacuous) both constants are parsed out of the script", () => {
    expect(fragment).not.toBeNull();
    expect(seam).not.toBeNull();
  });

  it("the emitted warning contains the fragment the predicate lower-cases and searches for", () => {
    const emitted = firstCapture(telemetry, /logger\.warn\(\s*\n?\s*"([^"]+)"/);
    expect(emitted).not.toBeNull();
    expect(emitted?.toLowerCase()).toContain(fragment);
  });

  it("the emitted warning is at a level the predicate accepts", () => {
    expect(telemetry).toContain("logger.warn(");
    expect(script).toContain('record.level === "warn"');
  });

  it("the wait span is opened under exactly the seam name the predicate filters on", () => {
    expect(seam).not.toBeNull();
    expect(telemetry).toContain(`startSpan('${seam}'`);
    expect(telemetry).toContain(`seam: '${seam}'`);
  });
});

describe("tenant-context errors — the SQLSTATE the predicate greps for", () => {
  const script = read(SCRIPTS, "alert-tenant-ctx-errors.mjs");
  const classification = read(SRC, "common", "observability", "error-classification.ts");
  const reporter = read(SRC, "common", "observability", "log-error-reporter.ts");

  const grepped = firstCapture(script, /line\.includes\("([^"]+)"\)/);
  const sqlstate = firstCapture(
    classification,
    /SQLSTATE_INSUFFICIENT_PRIVILEGE\s*=\s*"([^"]+)"/,
  );

  it("(anti-vacuous) both sides parse", () => {
    expect(grepped).not.toBeNull();
    expect(sqlstate).not.toBeNull();
  });

  it("the grepped code is the constant the application classifies on", () => {
    expect(grepped).toBe(sqlstate);
  });

  it("the reporter lifts that code onto the line, since it never appears in a driver message", () => {
    expect(reporter).toContain("sqlstate");
    expect(reporter).toContain('level: "error"');
    expect(script).toContain('record.level !== "error"');
  });
});

describe("git webhook signature failures — a log-only alert with no database state", () => {
  const script = read(SCRIPTS, "alert-sig-failures.mjs");
  const service = read(
    SRC,
    "modules",
    "integrations",
    "git",
    "integrations-git.service.ts",
  );

  /** The runbook in the script header is the predicate an operator will paste. */
  const documented = firstCapture(script, /contains\("([^"]+)"\)/);

  it("(anti-vacuous) the documented predicate is parsed out of the runbook", () => {
    expect(documented).not.toBeNull();
  });

  it("a real emitting line contains that phrase, at the level the runbook names", () => {
    expect(documented).not.toBeNull();
    const emitting = service
      .split("\n")
      .filter((line) => line.includes(documented as string));
    expect(emitting.length).toBeGreaterThan(0);
    expect(emitting.some((line) => line.includes("logger.warn("))).toBe(true);
  });
});

describe("retention dead-man — heartbeat keys, which fail loud rather than inert but still must match", () => {
  const script = read(SCRIPTS, "alert-retention-dead-man.mjs");
  const lease = read(SRC, "modules", "cron", "cron-lease.service.ts");

  const scriptPrefix = firstCapture(script, /HEARTBEAT_KEY_PREFIX\s*=\s*"([^"]+)"/);
  const servicePrefix = firstCapture(lease, /HEARTBEAT_KEY_PREFIX\s*=\s*"([^"]+)"/);
  const monitoredKeys = [...script.matchAll(/jobKey:\s*"([^"]+)"/g)].map((m) => m[1]);

  it("(anti-vacuous) the monitored sweeps and both prefixes parse", () => {
    expect(scriptPrefix).not.toBeNull();
    expect(servicePrefix).not.toBeNull();
    expect(monitoredKeys.length).toBeGreaterThan(0);
  });

  it("the key prefix the alert reads is the one the lease service writes", () => {
    expect(scriptPrefix).toBe(servicePrefix);
  });

  it.each(
    [...new Set([...script.matchAll(/jobKey:\s*"([^"]+)"/g)].map((m) => m[1]))].map((k) => [k]),
  )("a sweep really does take the lease under %s", (jobKey) => {
    const controllers = read(SRC, "modules", "cron", "cron-notifications.controller.ts")
      .concat(read(SRC, "modules", "cron", "cron-outbox.controller.ts"));
    expect(controllers).toContain(`withLease("${jobKey}"`);
  });
});
