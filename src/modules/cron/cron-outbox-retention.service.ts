import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq, isNotNull, lt, sql } from "drizzle-orm";
import { outboxEvents, inboxRecords } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";

export const OUTBOX_RETENTION_DAYS = 30;

const BATCH_SIZE = 1000;
const MAX_BATCHES = 50;

export interface OutboxRetentionResult {
  outboxEventsDeleted: number;
  inboxRecordsDeleted: number;
  truncated: boolean;
}

export interface OrgRetentionOutcome {
  outboxDeleted: number;
  inboxDeleted: number;
  truncated: boolean;
}

/**
 * Exported so the batching contract can be tested by calling it, rather than by
 * reaching through `Object.create(Service.prototype)` for a private method —
 * a seam that silently breaks the moment the method moves.
 */
export async function runBatchedDelete(
  run: (limit: number) => Promise<number>,
  onCapped: () => void,
): Promise<{ count: number; truncated: boolean }> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const affected = await run(BATCH_SIZE);
    total += affected;
    if (affected < BATCH_SIZE) return { count: total, truncated: false };
  }
  onCapped();
  return { count: total, truncated: true };
}

/**
 * Prunes one tenant's expired outbox and inbox rows. A free function, not a
 * private method, because `sweep()` cannot show whether it works: `forEachOrg`
 * catches the per-organisation throw, the sweep still reports zero-deleted, and
 * `cron-outbox.controller` still answers 200 — a total failure is
 * indistinguishable from a quiet night. Reachable on its own, a real-database
 * spec can seed eligible rows and assert a non-zero delete count.
 *
 * Every identifier is interpolated from the Drizzle declaration and every value
 * is bound through `eq`/`lt`, not typed as a literal. The statement it
 * replaces carried two independent defects that stacked, and both were invisible
 * to every static check and to a mocked db:
 *
 *   1. It named `org_id` on two tables whose tenant column is
 *      `organization_id` — every tenant raised 42703 at PARSE time, so nothing
 *      has ever been pruned and `OUTBOX_RETENTION_DAYS = 30` was never applied.
 *   2. Behind that, `cutoff` was a bare `Date` interpolated into a raw template,
 *      so it reached the driver with no column encoder. postgres.js resolves the
 *      parameter type from the server's description (OID 1114 `timestamp`) and
 *      hands the `Date` to the text serializer, which throws at BIND time.
 *      Correcting only the column name — the obvious fix — moves the failure
 *      from parse to bind; it does not remove it.
 *
 * So a renamed column is now a build error, and `cutoff` is encoded by the
 * column's own `timestamp` mapper rather than guessed at by the driver. Only the
 * `LIMIT` stays raw — Drizzle's delete builder has no `.limit()`, which is why
 * the batching needs the subselect at all.
 */
export async function sweepOrgOutboxRetention(
  tx: TenantTx,
  orgId: string,
  cutoff: Date,
  onCapped: () => void = () => undefined,
): Promise<OrgRetentionOutcome> {
  const outboxBatch = await runBatchedDelete(
    (limit) =>
      tx
        .delete(outboxEvents)
        .where(
          sql`${outboxEvents.outboxEventId} IN (
            SELECT ${outboxEvents.outboxEventId} FROM ${outboxEvents}
            WHERE ${eq(outboxEvents.organizationId, orgId)}
              AND ${outboxEvents.deliveryState} IN ('DELIVERED', 'DEAD', 'SUPPRESSED')
              AND ${lt(outboxEvents.occurredAt, cutoff)}
            LIMIT ${limit}
          )`,
        )
        .returning({ id: outboxEvents.outboxEventId })
        .then((rows) => rows.length),
    onCapped,
  );

  const inboxBatch = await runBatchedDelete(
    (limit) =>
      tx
        .delete(inboxRecords)
        .where(
          sql`${inboxRecords.inboxRecordId} IN (
            SELECT ${inboxRecords.inboxRecordId} FROM ${inboxRecords}
            WHERE ${eq(inboxRecords.organizationId, orgId)}
              AND ${isNotNull(inboxRecords.processedAt)}
              AND ${lt(inboxRecords.processedAt, cutoff)}
            LIMIT ${limit}
          )`,
        )
        .returning({ id: inboxRecords.inboxRecordId })
        .then((rows) => rows.length),
    onCapped,
  );

  return {
    outboxDeleted: outboxBatch.count,
    inboxDeleted: inboxBatch.count,
    truncated: outboxBatch.truncated || inboxBatch.truncated,
  };
}

@Injectable()
export class CronOutboxRetentionService {
  private readonly logger = new Logger(CronOutboxRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sweep(): Promise<OutboxRetentionResult> {
    const cutoff = new Date(Date.now() - OUTBOX_RETENTION_DAYS * 86_400_000);
    const result: OutboxRetentionResult = {
      outboxEventsDeleted: 0,
      inboxRecordsDeleted: 0,
      truncated: false,
    };

    const capped = (): void => {
      this.logger.warn(
        `[outbox-retention] hit the ${MAX_BATCHES}-batch cap with rows still eligible — rerun the sweep`,
      );
    };

    await forEachOrg(this.db, "outbox-retention", async (tx, orgId) => {
      const { outboxDeleted, inboxDeleted, truncated } = await sweepOrgOutboxRetention(
        tx,
        orgId,
        cutoff,
        capped,
      );
      result.outboxEventsDeleted += outboxDeleted;
      result.inboxRecordsDeleted += inboxDeleted;
      if (truncated) result.truncated = true;
    });

    this.logger.log(
      `[outbox-retention] outbox_events deleted=${result.outboxEventsDeleted} ` +
        `inbox_records deleted=${result.inboxRecordsDeleted} truncated=${result.truncated} cutoff=${cutoff.toISOString()}`,
    );
    return result;
  }
}
