import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetErrorReporter, setErrorReporter } from "../../common/observability";
import { LogErrorReporter } from "../../common/observability/log-error-reporter";
import {
  recordEmploymentFallback,
  reportEmploymentDrift,
  resetEmploymentFallbacks,
  snapshotEmploymentFallbacks,
} from "./employment-fallback-counter";

const SCRIPT = join(process.cwd(), "src", "scripts", "alert-employment-drift.mjs");

type AlertOutput = {
  fired: boolean;
  count: number;
  matches: Array<{ event: string; orgId: string | null; field: string | null; legacyValue: string | null }>;
};

function captureEmission(emit: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  const capture = (chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  process.stderr.write = capture as typeof process.stderr.write;
  try {
    emit();
  } finally {
    process.stderr.write = original;
  }
  return lines.join("").split("\n").filter((line) => line.trim().length > 0);
}

function runAlert(lines: string[], args: string[]): { output: AlertOutput; status: number } {
  const dir = mkdtempSync(join(tmpdir(), "employment-drift-"));
  const logFile = join(dir, "stderr.log");
  writeFileSync(logFile, `${lines.join("\n")}\n`);
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, `--log=${logFile}`, ...args], {
      encoding: "utf8",
    });
    return { output: JSON.parse(stdout) as AlertOutput, status: 0 };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return {
      output: JSON.parse(failure.stdout ?? "{}") as AlertOutput,
      status: failure.status ?? -1,
    };
  }
}

describe("employment drift alert", () => {
  beforeEach(() => {
    setErrorReporter(new LogErrorReporter());
    resetEmploymentFallbacks();
  });

  afterEach(() => {
    resetErrorReporter();
    resetEmploymentFallbacks();
  });

  it("fires on the line the application actually emits for a disagreement", () => {
    const lines = captureEmission(() => {
      reportEmploymentDrift("org_live", "usr_live", "designation", "Engineer", "Developer");
    });
    expect(lines).toHaveLength(1);

    const { output, status } = runAlert(lines, ["--kind=drift"]);
    expect(status).toBe(1);
    expect(output.fired).toBe(true);
    expect(output.count).toBe(1);
    expect(output.matches[0]).toMatchObject({
      event: "EMPLOYMENT_DRIFT",
      orgId: "org_live",
      field: "designation",
      legacyValue: "Developer",
    });
  });

  it("fires on the line the application actually emits for a legacy fallback", () => {
    const lines = captureEmission(() => {
      recordEmploymentFallback("org_live", "usr_live", "employeeNumber");
    });

    const { output, status } = runAlert(lines, ["--kind=fallback"]);
    expect(status).toBe(1);
    expect(output.count).toBe(1);
    expect(output.matches[0]).toMatchObject({
      event: "EMPLOYMENT_LEGACY_FALLBACK",
      orgId: "org_live",
      field: "employeeNumber",
    });
  });

  it("never puts a sensitive value in the alert payload", () => {
    const lines = captureEmission(() => {
      reportEmploymentDrift("org_live", "usr_live", "taxId", "CANONICAL-TAX", "LEGACY-TAX");
      reportEmploymentDrift("org_live", "usr_live", "bankDetails", { accountNumber: "999" }, null);
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("CANONICAL-TAX");
    expect(joined).not.toContain("LEGACY-TAX");
    expect(joined).not.toContain("999");

    const { output } = runAlert(lines, ["--kind=drift"]);
    expect(output.count).toBe(2);
    expect(output.matches[0]?.legacyValue).toBe("<redacted>");
  });

  it("stays clear on an unrelated error line", () => {
    const unrelated = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "ERROR_REPORT",
      sqlstate: "42501",
      error: { name: "Error", message: "permission denied for table notifications" },
    });

    const { output, status } = runAlert([unrelated], []);
    expect(status).toBe(0);
    expect(output.fired).toBe(false);
    expect(output.count).toBe(0);
  });

  it("counts every fallback so ticket 14 has a gate to read", () => {
    captureEmission(() => {
      recordEmploymentFallback("org_live", "usr_a", "designation");
      recordEmploymentFallback("org_live", "usr_b", "designation");
      recordEmploymentFallback("org_live", "usr_c", "joiningDate");
    });
    expect(snapshotEmploymentFallbacks()).toEqual({
      total: 3,
      byField: { designation: 2, joiningDate: 1 },
    });
  });
});
