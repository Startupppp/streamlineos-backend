import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "../..");
const repoDir = resolve(backendDir, "..");
const evidenceDir = resolve(repoDir, "architecture-refactor/final-refactor/evidence/45-scale");
const outputPath = resolve(evidenceDir, "S7-LIVE-DEV-EVIDENCE.md");

dotenv.config({ path: resolve(backendDir, ".env") });

const envNames = [
  "APP_DATABASE_URL",
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "NEON_API_KEY",
  "NEON_PROJECT_ID",
  "DB_REPLICA_URL",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "ABLY_API_KEY",
  "RESEND_API_KEY",
  "NEON_COMPUTE_RATE_USD_PER_HOUR",
  "NEON_STORAGE_RATE_USD_PER_GIB_MONTH",
  "NEON_TRANSFER_RATE_USD_PER_GIB",
  "CLOUDFLARE_R2_CLASS_A_RATE_USD_PER_MILLION",
  "CLOUDFLARE_R2_CLASS_B_RATE_USD_PER_MILLION",
  "CLOUDFLARE_R2_STORAGE_RATE_USD_PER_GB_MONTH",
  "RESEND_RATE_USD_PER_EMAIL",
];

function run(label, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: backendDir,
    encoding: "utf8",
    env: process.env,
  });
  return {
    label,
    exitCode: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function section(result) {
  return [
    `### ${result.label}`,
    "",
    `Exit code: ${result.exitCode}`,
    "",
    "```text",
    result.output || "(no output)",
    "```",
    "",
  ].join("\n");
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { parseError: true };
  }
}

const results = [
  run("Capacity snapshot", ["src/scripts/run-cell-capacity.mjs", "--json"]),
  run("Migration-chain verification", ["src/scripts/verify-migration-chain.mjs"]),
  run("Recovery tooling self-test", ["src/scripts/run-recovery-drill.mjs", "--self-test"]),
  run("Capacity tooling self-test", ["src/scripts/run-cell-capacity.mjs", "--self-test"]),
  run("Unit-cost tooling self-test", ["src/scripts/run-cell-unit-cost.mjs", "--self-test"]),
  run("Load-driver tooling self-test", ["src/scripts/__tests__/load-driver.test.mjs"]),
];

const recovery = readJson(resolve(backendDir, ".recovery-drill-results.json"));
const load = readJson(resolve(backendDir, ".load-driver-results.json"));
const capacity = readJson(resolve(backendDir, ".cell-capacity-history.json"));
const cost = readJson(resolve(backendDir, ".cell-cost-history.json"));
const generatedAt = new Date().toISOString();
const available = envNames.filter((name) => Boolean(process.env[name]));
const missing = envNames.filter((name) => !process.env[name]);

const report = [
  "# Session 7 live/dev evidence",
  "",
  `Generated: ${generatedAt}`,
  "",
  "This report contains command output and redacted capability status. It does not run a destructive recovery drill, restore, migration, or provisioning operation.",
  "",
  "## Credential capability",
  "",
  `Present: ${available.length > 0 ? available.join(", ") : "none"}`,
  `Missing: ${missing.length > 0 ? missing.join(", ") : "none"}`,
  "",
  "## Existing recovery evidence",
  "",
  recovery ? `\`backend/.recovery-drill-results.json\`: \`${JSON.stringify(recovery)}\`` : "No recovery result artifact found.",
  "",
  "The stored recovery result is the latest non-destructive evidence available in this run. A fresh cell recovery exercise remains operator-controlled because it drops and rebuilds a database cell.",
  "",
  "## Existing workload and trend evidence",
  "",
  load ? `Load result artifact present: ${load.requestCount ?? "unknown"} requests, ${load.achievedRps ?? "unknown"} requests/second.` : "No load result artifact found.",
  capacity ? `Capacity history entries: ${capacity.entries?.length ?? 0}.` : "No capacity history artifact found.",
  cost ? `Cost history entries: ${cost.entries?.length ?? 0}.` : "No cost history artifact found.",
  "",
  "## Reproducible checks",
  "",
  ...results.map(section),
  "## Operator-blocked items",
  "",
  "- Regional RPO/RTO branch-restore evidence requires Neon PITR access, a Neon API key, and an approved recovery window.",
  "- Physical replica lag evidence requires an independently provisioned read replica and DB_REPLICA_URL.",
  "- Dollar unit-cost evidence requires invoice-derived vendor rate variables and approval from the named cost owner.",
  "- Capacity and cost trend forecasts require at least three samples separated by 24 hours; this collector cannot manufacture those samples.",
  "- A colocated headroom run requires the approved cell deployment and load-runner placement; the current public-internet sample is not a colocated claim.",
  "",
].join("\n");

mkdirSync(evidenceDir, { recursive: true });
writeFileSync(outputPath, report, "utf8");
process.stdout.write(`WROTE ${outputPath}\n`);
process.stdout.write(`CHECKS ${results.filter((result) => result.exitCode === 0).length}/${results.length} passed\n`);
process.exitCode = results.every((result) => result.exitCode === 0) ? 0 : 1;
