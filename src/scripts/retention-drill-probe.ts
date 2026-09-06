import { writeFileSync } from "node:fs";
import { CronAnnouncementsRetentionService } from "../modules/cron/cron-announcements-retention.service";
import { CronHelpdeskRetentionService } from "../modules/cron/cron-helpdesk-retention.service";
import { CronMailRetentionService } from "../modules/cron/cron-mail-retention.service";
import {
  assessControlDeletion,
  runDrill,
  type DrillCheck,
  type DrillReport,
} from "./retention-drill-runner";

export type { DrillCheck, DrillReport };
export { assessControlDeletion };

export const PRODUCTION_RETENTION_PATHS: readonly {
  symbol: string;
  present: () => boolean;
}[] = [
  {
    symbol: "CronHelpdeskRetentionService.sweep",
    present: () =>
      typeof CronHelpdeskRetentionService.prototype.sweep === "function",
  },
  {
    symbol: "CronMailRetentionService.sweep",
    present: () =>
      typeof CronMailRetentionService.prototype.sweep === "function",
  },
  {
    symbol: "CronAnnouncementsRetentionService.sweep",
    present: () =>
      typeof CronAnnouncementsRetentionService.prototype.sweep === "function",
  },
  {
    symbol: "assessControlDeletion (anti-vacuity)",
    present: () => typeof assessControlDeletion === "function",
  },
  {
    symbol: "assessControlDeletion rejects zero deletions",
    present: () => assessControlDeletion(0, 3).ok === false,
  },
];

const arg = (name: string) =>
  process.argv
    .slice(2)
    .find((x) => x.startsWith(`--${name}=`))
    ?.slice(`--${name}=`.length);

function emit(report: DrillReport): void {
  const out = arg("out");
  if (!out) {
    process.stderr.write("--out=<path> required\n");
    return;
  }
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
}

async function main(): Promise<void> {
  if (process.argv.includes("--contract")) {
    emit({
      mode: "contract",
      checks: PRODUCTION_RETENTION_PATHS.map((p) => ({
        id: `contract.${p.symbol}`,
        phase: "control",
        productionPath: p.symbol,
        expected: "callable / correct",
        observed: p.present() ? "present and correct" : "MISSING or WRONG",
        ok: p.present(),
      })),
    });
    return;
  }
  const orgIdA = arg("org-a")?.trim();
  const orgIdB = arg("org-b")?.trim();
  const url = process.env.SCRATCH_DATABASE_URL;
  if (!orgIdA || !orgIdB) {
    emit({
      mode: "run",
      checks: [],
      error: "--org-a and --org-b are both required",
    });
    return;
  }
  if (!url) {
    emit({ mode: "run", checks: [], error: "SCRATCH_DATABASE_URL is not set" });
    return;
  }
  emit(await runDrill(orgIdA, orgIdB, url));
}

void main().then(
  () => process.exit(0),
  (err: unknown) => {
    emit({
      mode: "run",
      checks: [],
      error:
        err instanceof Error
          ? `${err.constructor.name}: ${err.message}`
          : String(err),
    });
    process.exit(0);
  },
);
