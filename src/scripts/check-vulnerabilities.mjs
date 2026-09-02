#!/usr/bin/env node
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SELF_TEST = process.argv.includes("--self-test");

/**
 * The verdict, as a pure function of an audit report. The gate and the self-test
 * both go through this. The previous self-test built a mock report and then
 * re-filtered it inline, so it asserted a copy of the rule and never touched the
 * rule the gate applies.
 */
export function evaluateAudit(report) {
  if (report === null || typeof report !== "object")
    return { verdict: "UNPARSEABLE", critical: 0, high: 0, advisories: [] };

  const meta = report.metadata?.vulnerabilities;
  if (meta === undefined || typeof meta !== "object")
    return { verdict: "UNPARSEABLE", critical: 0, high: 0, advisories: [] };

  const critical = Number(meta.critical ?? 0);
  const high = Number(meta.high ?? 0);
  const advisories = Object.values(report.advisories ?? {}).filter(
    (a) => a?.severity === "critical" || a?.severity === "high",
  );

  // A count of zero beside a listed high/critical advisory means the two halves
  // of the report disagree; treating that as OK would hide a real advisory.
  if (critical + high === 0 && advisories.length > 0)
    return { verdict: "INCONSISTENT", critical, high, advisories };

  return { verdict: critical + high > 0 ? "FAIL" : "OK", critical, high, advisories };
}

function runSelfTest() {
  let passed = 0;
  const failures = [];
  const assert = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };

  const criticalReport = {
    advisories: {
      1234: {
        severity: "critical",
        title: "MOCK: Remote Code Execution",
        module_name: "mock-package",
        recommendation: "Upgrade to v2.0.0",
        url: "https://example.com/advisory/1234",
      },
    },
    metadata: { vulnerabilities: { critical: 1, high: 0, moderate: 0, low: 0, info: 0 } },
  };
  const highReport = {
    advisories: { 9: { severity: "high", title: "H", module_name: "m", recommendation: "r", url: "u" } },
    metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 0, info: 0 } },
  };
  const moderateOnly = {
    advisories: { 9: { severity: "moderate", title: "M", module_name: "m", recommendation: "r", url: "u" } },
    metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 7, low: 3, info: 1 } },
  };
  const cleanReport = { advisories: {}, metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } } };
  const inconsistent = {
    advisories: { 9: { severity: "critical", title: "C", module_name: "m", recommendation: "r", url: "u" } },
    metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } },
  };

  const critical = evaluateAudit(criticalReport);
  assert("a critical advisory is a FAIL", critical.verdict === "FAIL");
  assert("the critical count is reported", critical.critical === 1);
  assert("the offending advisory is listed", critical.advisories.length === 1);
  assert("a high advisory is a FAIL", evaluateAudit(highReport).verdict === "FAIL");
  assert("moderate and low alone are OK", evaluateAudit(moderateOnly).verdict === "OK");
  assert("moderate advisories are not listed as offenders", evaluateAudit(moderateOnly).advisories.length === 0);
  assert("a clean report is OK", evaluateAudit(cleanReport).verdict === "OK");
  assert(
    "a zero count beside a listed critical advisory is INCONSISTENT, never OK",
    evaluateAudit(inconsistent).verdict === "INCONSISTENT",
  );
  assert("a report with no metadata is UNPARSEABLE, never OK", evaluateAudit({}).verdict === "UNPARSEABLE");
  assert("null is UNPARSEABLE, never OK", evaluateAudit(null).verdict === "UNPARSEABLE");
  assert("an empty-string parse result is UNPARSEABLE, never OK", evaluateAudit("").verdict === "UNPARSEABLE");

  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  FAIL: ${f}\n`);
    process.stderr.write(`check-vulnerabilities self-tests: ${failures.length} failed, ${passed} passed\n`);
    process.exit(1);
  }
  process.stdout.write(`check-vulnerabilities self-tests: ${passed} passed\n`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

process.stdout.write("[check:vulnerabilities] Running pnpm audit --prod --audit-level=high ...\n");

let auditJson;
try {
  auditJson = execSync("pnpm audit --prod --audit-level=high --json", {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
} catch (err) {
  auditJson = err.stdout ?? "";
  const stderr = err.stderr ?? "";
  if (!auditJson && stderr) {
    process.stderr.write(`[check:vulnerabilities] pnpm audit failed to produce JSON:\n${stderr}\n`);
    process.stderr.write("  Tip: re-run without --json to see the full error.\n");
    process.exit(2);
  }
}

let report;
try {
  report = JSON.parse(auditJson);
} catch {
  process.stderr.write(`[check:vulnerabilities] Could not parse audit JSON. Raw:\n${auditJson.slice(0, 500)}\n`);
  process.exit(2);
}

const result = evaluateAudit(report);

if (result.verdict === "UNPARSEABLE") {
  process.stderr.write(
    "[check:vulnerabilities] INCONCLUSIVE — the audit report carries no metadata.vulnerabilities block, so nothing was measured.\n",
  );
  process.exit(2);
}

if (result.verdict === "INCONSISTENT") {
  process.stderr.write(
    `[check:vulnerabilities] INCONCLUSIVE — the report lists ${result.advisories.length} high/critical advisory(ies) while its counts read zero. The two halves disagree; treating this as clean would hide them.\n`,
  );
  for (const adv of result.advisories)
    process.stderr.write(`  [${String(adv.severity).toUpperCase()}] ${adv.module_name}: ${adv.title}\n`);
  process.exit(2);
}

if (result.verdict === "FAIL") {
  process.stderr.write(
    `[check:vulnerabilities] FAIL — ${result.critical} critical, ${result.high} high vulnerabilities.\n`,
  );
  for (const adv of result.advisories) {
    process.stderr.write(`  [${String(adv.severity).toUpperCase()}] ${adv.module_name}: ${adv.title}\n`);
    process.stderr.write(`    Recommendation: ${adv.recommendation}\n`);
    process.stderr.write(`    Details: ${adv.url}\n`);
  }
  process.exit(1);
}

process.stdout.write("[check:vulnerabilities] OK — no high/critical vulnerabilities in production dependencies.\n");
