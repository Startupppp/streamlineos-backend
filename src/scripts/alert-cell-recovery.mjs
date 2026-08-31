import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = resolve(__dirname, "../..");

const args = process.argv.slice(2);
const hours = Math.max(1, parseInt(args.find((a) => a.startsWith("--hours="))?.slice(8) ?? "24", 10));
const resultsFile =
  args.find((a) => a.startsWith("--results-file="))?.slice("--results-file=".length) ??
  resolve(BACKEND_DIR, ".recovery-drill-results.json");

function predicate(cellVerifiedIso, windowMs) {
  return Date.now() - new Date(cellVerifiedIso).getTime() < windowMs;
}

if (args.includes("--self-test")) {
  const windowMs = hours * 3_600_000;
  const now = Date.now();
  const recentIso = new Date(now - 60_000).toISOString();
  const staleIso = new Date(now - (hours + 1) * 3_600_000).toISOString();
  const case1 = predicate(recentIso, windowMs);
  const case2 = predicate(staleIso, windowMs);
  const pass = case1 === true && case2 === false;
  process.stdout.write(
    JSON.stringify({
      selfTest: true,
      pass,
      case1FiresOnRecentRecovery: case1,
      case2ClearsOnStaleRecovery: !case2,
    }) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

let data;
try {
  data = JSON.parse(readFileSync(resultsFile, "utf8"));
} catch (e) {
  if (e.code === "ENOENT") {
    process.stderr.write(
      `PREREQUISITE: recovery drill results not found at ${resultsFile}\n` +
        `Run: node src/scripts/run-recovery-drill.mjs\n`,
    );
    process.exit(2);
  }
  process.stderr.write(`Failed to read results file: ${e.message}\n`);
  process.exit(2);
}

const cellVerifiedIso = data?.timestamps?.cell_verified_iso;
if (!cellVerifiedIso) {
  process.stderr.write(
    `PREREQUISITE: results file at ${resultsFile} has no timestamps.cell_verified_iso — re-run the recovery drill\n`,
  );
  process.exit(2);
}

const windowMs = hours * 3_600_000;
const fired = predicate(cellVerifiedIso, windowMs);
process.stdout.write(
  JSON.stringify({
    fired,
    cellId: "cell-2",
    restoredAt: cellVerifiedIso,
    rtoMet: data.rto_met ?? null,
    recoveredCellHealthy: data.recovered_cell_healthy ?? null,
    threshold: { windowHours: hours },
    destination:
      "CONFIGURE_ME — wire exit-code 1 to your oncall system (PagerDuty, Slack webhook, etc.)",
  }) + "\n",
);
process.exit(fired ? 1 : 0);
