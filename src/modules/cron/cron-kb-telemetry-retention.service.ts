import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, lt, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { kbEvents } from "../../db/schema";
import { kbIngestionCheckpoints } from "../../db/schema/support/kb-ingestion-checkpoints";
import { hrLegalHolds } from "../../db/schema/hr/governance";
import { organizationLegalHolds } from "../../db/schema/common/organization-purge";
import { organizationMembers } from "../../db/schema/common/auth";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";
import { OUTBOX_RETENTION_DAYS } from "./cron-outbox-retention.service";

/**
 * A full year of KB analytics. `kb_events` is the only source behind the analytics
 * overview, gaps, no-results and content-gaps reports, and `rangeSchema` leaves both
 * `from` and `to` optional — the screens send neither, so an unbounded read is the
 * default and every row still present is a row those reports scan. A year matches the
 * 365-day retention already decided for `chat_messages`, the other user-attributable
 * append-only stream in the product, so the two do not drift apart for no reason.
 */
export const KB_EVENTS_RETENTION_DAYS = 365;

/**
 * Checkpoints expire on the SAME horizon as the outbox dead-letter, deliberately
 * sharing the constant rather than restating the number.
 *
 * A checkpoint is a resume point for an ingestion still in flight, and
 * `KbIngestionCheckpointService.clearCheckpoints` fires only when ingestion SUCCEEDS.
 * An ingestion that dies — a crashed worker, a source stranded in `processing`, a
 * provider outage mid-batch — leaves its rows behind permanently, and each one holds a
 * full `vector(1536)`: roughly 6 KB of embedding plus the chunk text it was derived
 * from. Nothing resumes a run whose retry budget expired 30 days ago, so past that
 * point these are the largest orphan rows in the module.
 */
export const KB_CHECKPOINT_RETENTION_DAYS = OUTBOX_RETENTION_DAYS;

const BATCH_SIZE = 500;

export interface KbTelemetryRetentionResult {
  orgsProcessed: number;
  eventsDeleted: number;
  checkpointsDeleted: number;
}

/**
 * Retention for the two KB tables that had none, and that
 * `check:retention-coverage` could not see.
 *
 * The gate reports on tables at or above its size threshold in the live database, so a
 * table that is uncovered AND still small is invisible to it — which is exactly the
 * state both of these were in. That is a reporting gap, not an argument that they are
 * covered: `kb_events` takes a row on every article view and every search, and
 * `kb_ingestion_checkpoints` takes one per chunk with a 1536-dimension vector attached.
 * Both are now named in the gate's RETENTION_MATRIX so it can classify them by name
 * whether or not they have grown yet.
 */
@Injectable()
export class CronKbTelemetryRetentionService {
  private readonly logger = new Logger(CronKbTelemetryRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sweep(): Promise<KbTelemetryRetentionResult> {
    const now = Date.now();
    const eventCutoff = new Date(now - KB_EVENTS_RETENTION_DAYS * 86_400_000);
    const checkpointCutoff = new Date(now - KB_CHECKPOINT_RETENTION_DAYS * 86_400_000);

    let eventsDeleted = 0;
    let checkpointsDeleted = 0;

    const result = await forEachOrg(this.db, "kb-telemetry-retention", async (tx, orgId) => {
      eventsDeleted += await this.pruneEvents(tx, orgId, eventCutoff);
      checkpointsDeleted += await this.pruneCheckpoints(tx, orgId, checkpointCutoff);
    });

    this.logger.log(
      `KB telemetry retention: deleted ${eventsDeleted} events and ${checkpointsDeleted} ingestion checkpoints across ${result.succeeded} orgs`,
    );

    return { orgsProcessed: result.succeeded, eventsDeleted, checkpointsDeleted };
  }

  /**
   * A `kb_events` row carries the searcher's own free text in `query` and names them in
   * `actor_membership_id`, so it is discoverable material: an org-wide legal hold, or an
   * HR hold naming that actor, stops the sweep for those rows exactly as it does for
   * `kb_chat_conversations`.
   */
  private async pruneEvents(tx: TenantTx, orgId: string, cutoff: Date): Promise<number> {
    return this.deleteInBatches(
      () =>
        tx
          .select({ id: kbEvents.id })
          .from(kbEvents)
          .where(
            and(
              eq(kbEvents.orgId, orgId),
              lt(kbEvents.occurredAt, cutoff),
              this.noOrgLegalHold(kbEvents.orgId),
              sql`NOT EXISTS (
                SELECT 1
                FROM ${hrLegalHolds}
                WHERE ${hrLegalHolds.orgId} = ${kbEvents.orgId}
                  AND ${hrLegalHolds.status} = 'active'
                  AND ${hrLegalHolds.deletedAt} IS NULL
                  AND (
                    ${hrLegalHolds.subjectMembershipId} = ${kbEvents.actorMembershipId}
                    OR ${hrLegalHolds.subjectUserId} IN (
                      SELECT ${organizationMembers.userId}
                      FROM ${organizationMembers}
                      WHERE ${organizationMembers.orgId} = ${kbEvents.orgId}
                        AND ${organizationMembers.id} = ${kbEvents.actorMembershipId}
                    )
                  )
              )`,
            ),
          )
          .limit(BATCH_SIZE),
      (ids) => tx.delete(kbEvents).where(inArray(kbEvents.id, ids)),
    );
  }

  /**
   * A checkpoint is derived data — it is rebuilt by re-running ingestion — so only the
   * org-wide hold applies. There is no subject to hold on: the row names a content id,
   * never a person.
   */
  private async pruneCheckpoints(tx: TenantTx, orgId: string, cutoff: Date): Promise<number> {
    return this.deleteInBatches(
      () =>
        tx
          .select({ id: kbIngestionCheckpoints.id })
          .from(kbIngestionCheckpoints)
          .where(
            and(
              eq(kbIngestionCheckpoints.orgId, orgId),
              lt(kbIngestionCheckpoints.createdAt, cutoff),
              this.noOrgLegalHold(kbIngestionCheckpoints.orgId),
            ),
          )
          .limit(BATCH_SIZE),
      (ids) =>
        tx.delete(kbIngestionCheckpoints).where(inArray(kbIngestionCheckpoints.id, ids)),
    );
  }

  private noOrgLegalHold(orgColumn: AnyColumn): SQL {
    return sql`NOT EXISTS (
      SELECT 1
      FROM ${organizationLegalHolds}
      WHERE ${organizationLegalHolds.orgId} = ${orgColumn}
        AND ${organizationLegalHolds.releasedAt} IS NULL
    )`;
  }

  /**
   * Bounded batches rather than one unqualified DELETE: a year of events for a busy
   * tenant is a lock held for as long as the delete runs, and `forEachOrg` gives each
   * org one transaction to share with every other sweep in the tick.
   */
  private async deleteInBatches(
    selectBatch: () => Promise<Array<{ id: number }>>,
    deleteBatch: (ids: number[]) => Promise<unknown>,
  ): Promise<number> {
    let deleted = 0;
    for (;;) {
      const rows = await selectBatch();
      if (rows.length === 0) break;
      await deleteBatch(rows.map((r) => r.id));
      deleted += rows.length;
      if (rows.length < BATCH_SIZE) break;
    }
    return deleted;
  }
}
