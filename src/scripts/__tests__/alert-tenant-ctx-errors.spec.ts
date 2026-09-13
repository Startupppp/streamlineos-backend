import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(__dirname, "../alert-tenant-ctx-errors.mjs");

function run(
  input: string,
  args: string[] = [],
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", [SCRIPT, ...args], {
    input,
    encoding: "utf8",
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function lastJson(stdout: string): Record<string, unknown> {
  const last = stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(last) as Record<string, unknown>;
}

describe("alert-tenant-ctx-errors --self-test", () => {
  it("exits 0 and emits {pass:true} (all five outcome cases covered)", () => {
    const { stdout, stderr, status } = run("", ["--self-test"]);
    expect(status).toBe(0);
    const parsed = lastJson(stdout);
    expect(parsed.selfTest).toBe(true);
    expect(parsed.pass).toBe(true);
    expect(stderr).toBe("");
  });

  it("covers all five outcome cases (self-test is not hollow)", () => {
    const { stdout, status } = run("", ["--self-test"]);
    expect(status).toBe(0);
    const parsed = lastJson(stdout);
    expect(parsed.caseNormal).toBe(true);
    expect(parsed.caseNoData).toBe(true);
    expect(parsed.caseMalformed).toBe(true);
    expect(parsed.caseNoRelevantEvents).toBe(true);
    expect(parsed.caseHealthy).toBe(true);
  });
});

describe("alert-tenant-ctx-errors — NO_DATA (bite test)", () => {
  it("exits 2 and reports NO_DATA on empty input — not 0 (clear)", () => {
    const { stdout, stderr, status } = run("");
    expect(status).toBe(2);
    const parsed = lastJson(stdout);
    expect(parsed.outcome).toBe("NO_DATA");
    expect(parsed.fired).toBe(false);
    expect(stderr).toContain("NO_DATA");
  });

  it("exits 2 on whitespace-only input", () => {
    const { status } = run("   \n\n  ");
    expect(status).toBe(2);
  });
});

describe("alert-tenant-ctx-errors — MALFORMED (bite test)", () => {
  it("exits 2 and reports MALFORMED when no line parses as JSON", () => {
    const { stdout, stderr, status } = run("not json at all\nalso not json\n");
    expect(status).toBe(2);
    const parsed = lastJson(stdout);
    expect(parsed.outcome).toBe("MALFORMED");
    expect(parsed.fired).toBe(false);
    expect(stderr).toContain("MALFORMED");
  });
});

describe("alert-tenant-ctx-errors — NO_RELEVANT_EVENTS (bite test)", () => {
  it("exits 2 and reports NO_RELEVANT_EVENTS when valid JSON exists but no error-level lines", () => {
    const lines = [
      JSON.stringify({ timestamp: new Date().toISOString(), level: "info", message: "server started" }),
      JSON.stringify({ timestamp: new Date().toISOString(), level: "warn", message: "slow query" }),
    ].join("\n");
    const { stdout, stderr, status } = run(lines);
    expect(status).toBe(2);
    const parsed = lastJson(stdout);
    expect(parsed.outcome).toBe("NO_RELEVANT_EVENTS");
    expect(parsed.fired).toBe(false);
    expect(stderr).toContain("NO_RELEVANT_EVENTS");
  });
});

describe("alert-tenant-ctx-errors — HEALTHY (exit 0, no alert)", () => {
  it("exits 0 and reports HEALTHY when error-level lines exist but none contain 42501", () => {
    const lines = [
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        message: "Something unrelated",
        correlationId: "corr-x",
      }),
    ].join("\n");
    const { stdout, status } = run(lines);
    expect(status).toBe(0);
    const parsed = lastJson(stdout);
    expect(parsed.outcome).toBe("HEALTHY");
    expect(parsed.fired).toBe(false);
  });
});

describe("alert-tenant-ctx-errors — FIRED (exit 1, alert fires)", () => {
  it("exits 1 and reports FIRED when a 42501 error-level line is in the window", () => {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "ERROR_REPORT",
      correlationId: "corr-1",
      orgId: "org_fixture",
      route: "/notifications",
      sqlstate: "42501",
      errorClass: "tenant-context",
    });
    const { stdout, status } = run(line);
    expect(status).toBe(1);
    const parsed = lastJson(stdout);
    expect(parsed.outcome).toBe("FIRED");
    expect(parsed.fired).toBe(true);
    expect(parsed.count).toBe(1);
  });
});

describe("alert-tenant-ctx-errors — probe-whose-failure-equals-success guard", () => {
  it("FIRED and HEALTHY produce different exit codes", () => {
    const now = new Date().toISOString();
    const alertLine = JSON.stringify({ timestamp: now, level: "error", message: "ERROR_REPORT", sqlstate: "42501" });
    const safeLine = JSON.stringify({ timestamp: now, level: "error", message: "Something else" });
    const fired = run(alertLine);
    const healthy = run(safeLine);
    expect(fired.status).toBe(1);
    expect(healthy.status).toBe(0);
    expect(fired.status).not.toBe(healthy.status);
  });
});
