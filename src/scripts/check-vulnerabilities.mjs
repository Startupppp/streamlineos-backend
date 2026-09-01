#!/usr/bin/env node
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SELF_TEST = process.argv.includes("--self-test");

if (SELF_TEST) {
  const mockOutput = JSON.stringify({
    advisories: {
      "1234": {
        severity: "critical",
        title: "MOCK: Remote Code Execution",
        module_name: "mock-package",
        recommendation: "Upgrade to v2.0.0",
        url: "https://example.com/advisory/1234",
      },
    },
    metadata: { vulnerabilities: { critical: 1, high: 0, moderate: 0, low: 0, info: 0 } },
  });

  const parsed = JSON.parse(mockOutput);
  const crits = Object.values(parsed.advisories).filter((a) => a.severity === "critical" || a.severity === "high");
  if (crits.length !== 1) {
    process.stderr.write("SELF-TEST FAILED: expected 1 critical advisory in mock.\n");
    process.exit(1);
  }
  process.stdout.write("SELF-TEST PASSED: vulnerability detector identifies high/critical advisories.\n");
  process.exit(0);
}

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
    process.exit(1);
  }
}

let report;
try {
  report = JSON.parse(auditJson);
} catch {
  process.stderr.write(`[check:vulnerabilities] Could not parse audit JSON. Raw:\n${auditJson.slice(0, 500)}\n`);
  process.exit(1);
}

const vulnerabilities = report?.metadata?.vulnerabilities ?? {};
const critical = vulnerabilities.critical ?? 0;
const high = vulnerabilities.high ?? 0;
const total = critical + high;

if (total > 0) {
  process.stderr.write(`[check:vulnerabilities] FAIL — ${critical} critical, ${high} high vulnerabilities.\n`);
  const advisories = Object.values(report.advisories ?? {}).filter(
    (a) => a.severity === "critical" || a.severity === "high",
  );
  for (const adv of advisories) {
    process.stderr.write(`  [${adv.severity.toUpperCase()}] ${adv.module_name}: ${adv.title}\n`);
    process.stderr.write(`    Recommendation: ${adv.recommendation}\n`);
    process.stderr.write(`    Details: ${adv.url}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `[check:vulnerabilities] OK — no high/critical vulnerabilities in production dependencies.\n`,
);
