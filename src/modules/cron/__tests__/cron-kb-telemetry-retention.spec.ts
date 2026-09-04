import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CronKbTelemetryRetentionService,
  KB_EVENTS_RETENTION_DAYS,
  KB_CHECKPOINT_RETENTION_DAYS,
} from "../cron-kb-telemetry-retention.service";
import { OUTBOX_RETENTION_DAYS } from "../cron-outbox-retention.service";
import { RETENTION_JOBS, UNSCHEDULED_PURGE_JOBS } from "../retention-schedule";
import type { Db } from "../../../db/drizzle.module";

const CRON_DIR = resolve(__dirname, "..");
const SERVICE = readFileSync(resolve(CRON_DIR, "cron-kb-telemetry-retention.service.ts"), "utf8");
const MATRIX = readFileSync(
  resolve(__dirname, "..", "..", "..", "scripts", "check-retention-coverage.mjs"),
  "utf8",
);

/**
 * `kb_events` and `kb_ingestion_checkpoints` had no retention at all, and
 * `check:retention-coverage` could not tell anyone: it reports on tables at or above its
 * size threshold in the live database, so a table that is uncovered AND still small is
 * never classified — and "absent from the report" reads exactly like "fine". Both are now
 * named in RETENTION_MATRIX, so the gate answers for them by name rather than by waiting
 * for them to grow.
 *
 * `kb_pages` is the third: its purge worker existed, was correct, and was DELIBERATELY
 * unscheduled, the stated reason being the absence of an inventory entry. Against a live
 * database it read UNCOVERED.
 */
describe("KB retention — the tables the coverage gate could not see", () => {
  it("names all three KB tables in the gate's matrix", () => {
    expect(MATRIX).toContain("kb_events: {");
    expect(MATRIX).toContain("kb_ingestion_checkpoints: {");
    expect(MATRIX).toContain("kb_pages: {");
  });

  it("schedules kb-trash-purge instead of listing it as deliberately unscheduled", () => {
    expect(RETENTION_JOBS.map((j) => j.jobKey)).toContain("kb-trash-purge");
    expect(UNSCHEDULED_PURGE_JOBS.map((j) => j.jobKey)).not.toContain("kb-trash-purge");
  });

  it("declares the telemetry sweep on a daily cadence with a dead-man window past it", () => {
    const job = RETENTION_JOBS.find((j) => j.jobKey === "kb-telemetry-retention-sweep");
    if (!job) throw new Error("kb-telemetry-retention-sweep is not declared");
    expect(job.sweepName).toBe("kb-telemetry-retention");
    expect(job.maxAgeMs).toBeGreaterThan(job.intervalMs);
  });

  /**
   * Shared, not restated. A checkpoint is a resume point for an ingestion still in
   * flight, so the horizon past which nothing will resume it is the same horizon past
   * which the outbox stops retrying. Two independent literals would drift.
   */
  it("expires checkpoints on the outbox dead-letter horizon by sharing its constant", () => {
    expect(KB_CHECKPOINT_RETENTION_DAYS).toBe(OUTBOX_RETENTION_DAYS);
    expect(SERVICE).toContain("KB_CHECKPOINT_RETENTION_DAYS = OUTBOX_RETENTION_DAYS");
    expect(SERVICE).not.toMatch(/KB_CHECKPOINT_RETENTION_DAYS\s*=\s*\d/);
  });

  it("keeps a year of events, the same window chat_messages keeps", () => {
    expect(KB_EVENTS_RETENTION_DAYS).toBe(365);
  });

  /**
   * A `kb_events` row carries the searcher's own free text and names them by membership,
   * so it is discoverable material. Deleting it out from under a hold is the failure this
   * pins — and it is the reason the sweep cannot be a bare `DELETE ... WHERE occurred_at <`.
   */
  it("stops at a legal hold on both tables", () => {
    expect(SERVICE).toContain("organizationLegalHolds");
    expect(SERVICE).toContain("hrLegalHolds");
    expect(SERVICE).toContain("this.noOrgLegalHold(kbEvents.orgId)");
    expect(SERVICE).toContain("this.noOrgLegalHold(kbIngestionCheckpoints.orgId)");
  });

  it("deletes in bounded batches rather than one unqualified statement", () => {
    expect(SERVICE).toContain("BATCH_SIZE");
    expect(SERVICE).not.toMatch(/tx\s*\.delete\(kbEvents\)\s*\.where\(\s*and\(/);
  });
});

describe("CronKbTelemetryRetentionService.sweep", () => {
  function makeDb(rowsPerBatch: number[]): { db: Db; deleted: number[][] } {
    const deleted: number[][] = [];
    let batch = 0;

    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              const n = rowsPerBatch[batch] ?? 0;
              batch += 1;
              return Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
            },
          }),
        }),
      }),
      delete: () => ({
        where: async () => {
          deleted.push([]);
          return [];
        },
      }),
      execute: async () => [],
    };

    const db = {
      transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      ...tx,
    } as unknown as Db;

    return { db, deleted };
  }

  /**
   * `forEachOrg` enumerates organisations from the database. The sweep itself is what is
   * under test, so it runs against one synthetic org rather than booting the enumeration.
   */
  it("stops after a short batch instead of looping forever", async () => {
    const { db, deleted } = makeDb([500, 500, 3]);
    const service = new CronKbTelemetryRetentionService(db);
    const prune = Reflect.get(service, "pruneEvents") as (
      tx: unknown,
      orgId: string,
      cutoff: Date,
    ) => Promise<number>;

    const count = await prune.call(service, await unwrapTx(db), "org-1", new Date(0));

    expect(count).toBe(1003);
    expect(deleted).toHaveLength(3);
  });

  it("returns zero without issuing a delete when nothing has expired", async () => {
    const { db, deleted } = makeDb([0]);
    const service = new CronKbTelemetryRetentionService(db);
    const prune = Reflect.get(service, "pruneCheckpoints") as (
      tx: unknown,
      orgId: string,
      cutoff: Date,
    ) => Promise<number>;

    const count = await prune.call(service, await unwrapTx(db), "org-1", new Date(0));

    expect(count).toBe(0);
    expect(deleted).toHaveLength(0);
  });
});

async function unwrapTx(db: Db): Promise<unknown> {
  return (db as unknown as { transaction: (fn: (t: unknown) => Promise<unknown>) => Promise<unknown> })
    .transaction(async (t) => t);
}
