import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { kbSources } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant";
import type { TenantTx } from "../../../common/tenant";
import {
  KbIngestionLeaseService,
  type KbIngestionLeaseHealth,
} from "./kb-ingestion-lease.service";
import {
  KbIndexedBytesQuotaService,
  kbSourceIndexedBytes,
} from "../core/kb-indexed-bytes-quota.service";

export interface KbStuckSourceReapBatch {
  sourcesFailed: number;
  releasedBytes: number;
}

export const KB_SOURCE_STUCK_AFTER_MS = 30 * 60_000;
export const KB_SOURCE_REAP_BATCH = 200;

export const KB_SOURCE_STUCK_MESSAGE =
  "Ingestion never completed. The kb.content.index event was lost or exhausted its retries — " +
  "drain the outbox dead-letter queue to re-run it, or re-upload this source.";

export interface KbStuckSourceReapResult {
  orgsProcessed: number;
  orgsFailed: number;
  sourcesFailed: number;
  truncated: boolean;
  leaseHealth: KbIngestionLeaseHealth;
}

export async function reapOrgStuckSources(
  tx: TenantTx,
  orgId: string,
  cutoff: Date,
): Promise<KbStuckSourceReapBatch> {
  const rows = await tx
    .update(kbSources)
    .set({ status: "failed", errorMessage: KB_SOURCE_STUCK_MESSAGE })
    .where(
      sql`${kbSources.id} in (
        select ${kbSources.id} from ${kbSources}
        where ${and(
          eq(kbSources.orgId, orgId),
          eq(kbSources.status, "processing"),
          isNull(kbSources.deletedAt),
          lt(kbSources.updatedAt, cutoff),
        )}
        order by ${kbSources.id}
        limit ${KB_SOURCE_REAP_BATCH}
      )`,
    )
    .returning({
      id: kbSources.id,
      kind: kbSources.kind,
      noteText: kbSources.noteText,
      fileSize: kbSources.fileSize,
    });

  return {
    sourcesFailed: rows.length,
    releasedBytes: rows.reduce(
      (total, row) => total + kbSourceIndexedBytes(row),
      0,
    ),
  };
}

@Injectable()
export class KbStuckSourceReaperService {
  private readonly logger = new Logger(KbStuckSourceReaperService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly leaseService: KbIngestionLeaseService,
    private readonly quota: KbIndexedBytesQuotaService,
  ) {}

  async reap(): Promise<KbStuckSourceReapResult> {
    const cutoff = new Date(Date.now() - KB_SOURCE_STUCK_AFTER_MS);
    let sourcesFailed = 0;
    let truncated = false;

    const outcome = await forEachOrg(
      this.db,
      "kb-stuck-source-reaper",
      async (tx, orgId) => {
        const reaped = await reapOrgStuckSources(tx, orgId, cutoff);
        sourcesFailed += reaped.sourcesFailed;
        await this.quota.release(orgId, reaped.releasedBytes);
        if (reaped.sourcesFailed >= KB_SOURCE_REAP_BATCH) truncated = true;
      },
    );

    const leaseHealth = this.leaseService.health();

    if (
      sourcesFailed > 0 ||
      leaseHealth.unavailableCount > 0 ||
      leaseHealth.lostCount > 0
    )
      this.logger.error(
        `[kb-stuck-source-reaper] failed ${sourcesFailed} source(s) stuck in 'processing' past ` +
          `${KB_SOURCE_STUCK_AFTER_MS}ms; lease unavailable=${leaseHealth.unavailableCount} ` +
          `contended=${leaseHealth.contendedCount} lost=${leaseHealth.lostCount} ` +
          `lastUnavailableReason=${leaseHealth.lastUnavailableReason ?? "none"}`,
      );

    return {
      orgsProcessed: outcome.succeeded,
      orgsFailed: outcome.failed,
      sourcesFailed,
      truncated,
      leaseHealth,
    };
  }
}
