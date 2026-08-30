import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { filterWellSpacedSamples, MIN_SAMPLE_SPACING_MS, CAPACITY_BUDGETS } from "./cell-capacity-budgets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAP_HISTORY_PATH = resolve(__dirname, "../../.cell-capacity-history.json");
const COST_HISTORY_PATH = resolve(__dirname, "../../.cell-cost-history.json");

const SPACING_DAYS = Math.round(MIN_SAMPLE_SPACING_MS / 86_400_000);
const SAMPLES_NEEDED = 3;

const COST_TRACKED = [
  { key: "milliCreditsPerToken", label: "AI cost/token (milli-credits/token)" },
  { key: "activeOrgs", label: "active organizations" },
  { key: "dbSizeGb", label: "database size (GB)" },
];

function loadHistory(path) {
  if (!existsSync(path)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { entries: [] };
  }
}

function qualifyingEntries(entries) {
  return entries.filter((e) => !e.duringBulkLoad);
}

function nextQualifyingAt(entries) {
  const spaced = filterWellSpacedSamples(qualifyingEntries(entries));
  if (spaced.length === 0) return "now";
  const last = spaced[spaced.length - 1];
  return new Date(last.ts + MIN_SAMPLE_SPACING_MS).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function spacedCount(entries) {
  return filterWellSpacedSamples(qualifyingEntries(entries)).length;
}

function printRow(label, count, nextAfter) {
  const status = count >= SAMPLES_NEEDED ? "READY" : `${count}/${SAMPLES_NEEDED} — next after ${nextAfter}`;
  process.stdout.write(`  ${label.padEnd(40)} ${status}\n`);
}

function main() {
  const capHistory = loadHistory(CAP_HISTORY_PATH);
  const costHistory = loadHistory(COST_HISTORY_PATH);

  process.stdout.write(`Cell forecast readiness  (≥${SPACING_DAYS}d spacing · ${SAMPLES_NEEDED} samples needed per metric)\n`);
  process.stdout.write("=".repeat(70) + "\n\n");

  process.stdout.write("Capacity resources  (source: .cell-capacity-history.json)\n");
  process.stdout.write("-".repeat(70) + "\n");

  if (capHistory.entries.length === 0) {
    process.stdout.write("  No samples yet — run: node src/scripts/run-cell-capacity.mjs --record-only\n");
  } else {
    for (const budget of CAPACITY_BUDGETS) {
      const relevant = capHistory.entries.filter(
        (e) => e.resources?.[budget.id] != null && e.resources[budget.id].limit > 0,
      );
      const next = nextQualifyingAt(relevant);
      printRow(budget.resource, spacedCount(relevant), next);
    }
    const bulkFlagged = capHistory.entries.filter((e) => e.duringBulkLoad).length;
    const closeFlagged = capHistory.entries.filter((e) => e.tooCloseToPrevious).length;
    process.stdout.write(`\n  ${capHistory.entries.length} total, ${bulkFlagged} bulk-load flagged, ${closeFlagged} too-close flagged.\n`);
  }

  process.stdout.write("\nCost trend units  (source: .cell-cost-history.json)\n");
  process.stdout.write("-".repeat(70) + "\n");

  if (costHistory.entries.length === 0) {
    process.stdout.write("  No samples yet — run: node src/scripts/run-cell-unit-cost.mjs --record-only\n");
  } else {
    for (const { key, label } of COST_TRACKED) {
      const relevant = costHistory.entries.filter(
        (e) => e[key] != null && Number.isFinite(e[key]),
      );
      const next = nextQualifyingAt(relevant);
      printRow(label, spacedCount(relevant), next);
    }
    const costBulk = costHistory.entries.filter((e) => e.duringBulkLoad).length;
    const costClose = costHistory.entries.filter((e) => e.tooCloseToPrevious).length;
    process.stdout.write(`\n  ${costHistory.entries.length} total, ${costBulk} bulk-load flagged, ${costClose} too-close flagged.\n`);
  }

  process.stdout.write("\nSchedule: .github/workflows/cell-daily-samples.yml — daily at 02:00 UTC.\n");
  process.stdout.write("Manual:   pnpm cell:capacity:record   pnpm cell:cost:record\n");
}

main();
