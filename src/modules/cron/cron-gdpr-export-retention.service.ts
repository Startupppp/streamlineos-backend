import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, gt, inArray, isNotNull, lt, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg, withTenant } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";
import { gdprExportJobs, hrAuditLogs } from "../../db/schema";
import { StorageService } from "../storage/storage.service";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
/** Longer than any single export run, so a live worker is never reclaimed out from under itself. */
const STALE_LOCK_MS = 30 * 60_000;
const UPDATE_CHUNK = 200;

interface RetiredArtifact {
  id: string;
  fileKey: string;
}

export interface GdprExportRetentionResult {
  organizations: number;
  organizationsFailed: number;
  jobsReclaimed: number;
  jobsExpired: number;
  objectsDeleted: number;
  objectsOrphaned: number;
  truncated: boolean;
}

/**
 * Retention for the GDPR subject-export artifact — the one object in the system that is a
 * complete dump of one person's personal data.
 *
 * `GdprExportService` declared a 72-hour expiry and shipped `expireOldJobs` and `reclaim`
 * to enforce it. Neither had a single caller anywhere in `src/`, so nothing ever expired:
 * every export archive ever produced stayed `completed` and downloadable in object storage
 * for ever, and a worker that died between `claim` and `complete` left its job wedged in
 * `running` — `claim` only ever selects `pending`, so that subject's export never resumed.
 *
 * Ordering is load-bearing. The row is marked `expired` first and keeps its `file_key`, then
 * the object is deleted, and only a delete that succeeded clears the pointer. Nulling the key
 * first would leave an unreachable object in the bucket with nothing naming it; leaving the key
 * on a failed delete means the next tick retries it, which is why the eligibility predicate
 * matches `expired` rows that still carry a key.
 */
@Injectable()
export class CronGdprExportRetentionService {
  private readonly logger = new Logger(CronGdprExportRetentionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  async sweep(): Promise<GdprExportRetentionResult> {
    const result: GdprExportRetentionResult = {
      organizations: 0,
      organizationsFailed: 0,
      jobsReclaimed: 0,
      jobsExpired: 0,
      objectsDeleted: 0,
      objectsOrphaned: 0,
      truncated: false,
    };
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    const retired = new Map<string, RetiredArtifact[]>();

    const sweepResult = await forEachOrg(
      this.db,
      "gdpr-export-retention",
      async (tx, orgId) => {
        const reclaimed = await this.reclaimStale(tx, orgId, staleBefore);
        result.jobsReclaimed += reclaimed;

        const { entries, truncated } = await this.expireArtifacts(tx, orgId, now);
        if (truncated) result.truncated = true;
        result.jobsExpired += entries.length;
        if (entries.length > 0) retired.set(orgId, entries);

        if (reclaimed > 0 || entries.length > 0)
          await this.auditLog(tx, orgId, reclaimed, entries.length, truncated, now);
      },
    );

    result.organizations = sweepResult.organizations;
    result.organizationsFailed = sweepResult.failed;

    await this.purgeRetiredObjects(retired, result);

    this.logger.log(
      `[gdpr-export-retention] sweep complete: ${result.organizations} orgs ` +
        `(${result.organizationsFailed} failed), ${result.jobsReclaimed} stale jobs reclaimed, ` +
        `${result.jobsExpired} artifacts expired, ${result.objectsDeleted} objects deleted, ` +
        `${result.objectsOrphaned} objects left orphaned, truncated=${result.truncated}`,
    );
    return result;
  }

  /**
   * A job whose worker died mid-run holds `running` for ever, because `claim` only reads
   * `pending`. One statement, no page: an UPDATE with no LIMIT cannot under-report.
   */
  private async reclaimStale(
    tx: TenantTx,
    orgId: string,
    staleBefore: Date,
  ): Promise<number> {
    const rows = await tx
      .update(gdprExportJobs)
      .set({ status: "pending", lockedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(gdprExportJobs.orgId, orgId),
          eq(gdprExportJobs.status, "running"),
          lte(gdprExportJobs.lockedAt, staleBefore),
        ),
      )
      .returning({ id: gdprExportJobs.id });
    return rows.length;
  }

  /**
   * Keyset-drains on `id` rather than re-selecting the head of the same predicate: marking a
   * row `expired` does not stop it matching (an expired row keeps its key until the object is
   * gone), so a re-select loop would read the same page for ever.
   */
  private async expireArtifacts(
    tx: TenantTx,
    orgId: string,
    now: Date,
  ): Promise<{ entries: RetiredArtifact[]; truncated: boolean }> {
    const entries: RetiredArtifact[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const rows: Array<{ id: string; fileKey: string | null }> = await tx
        .select({ id: gdprExportJobs.id, fileKey: gdprExportJobs.fileKey })
        .from(gdprExportJobs)
        .where(
          and(
            eq(gdprExportJobs.orgId, orgId),
            isNotNull(gdprExportJobs.fileKey),
            lt(gdprExportJobs.expiresAt, now),
            inArray(gdprExportJobs.status, ["completed", "expired"]),
            ...(cursor === null ? [] : [gt(gdprExportJobs.id, cursor)]),
          ),
        )
        .orderBy(asc(gdprExportJobs.id))
        .limit(PAGE_SIZE);

      if (rows.length === 0) return { entries, truncated: false };

      await tx
        .update(gdprExportJobs)
        .set({ status: "expired", fileName: null, updatedAt: new Date() })
        .where(
          and(
            eq(gdprExportJobs.orgId, orgId),
            inArray(
              gdprExportJobs.id,
              rows.map((row) => row.id),
            ),
          ),
        );

      for (const row of rows)
        if (row.fileKey) entries.push({ id: row.id, fileKey: row.fileKey });

      const last = rows[rows.length - 1];
      if (rows.length < PAGE_SIZE || !last || last.id === cursor)
        return { entries, truncated: false };
      cursor = last.id;
    }

    this.logger.warn(
      `[gdpr-export-retention] org ${orgId} hit the ${MAX_PAGES}-page cap with artifacts still eligible — the next tick resumes`,
    );
    return { entries, truncated: true };
  }

  /**
   * Outside the per-tenant transaction: a bucket round-trip per row is not something to hold
   * a database transaction open across. A delete that throws leaves the key in place, so the
   * next sweep retries it instead of stranding the object with nothing naming it.
   */
  private async purgeRetiredObjects(
    retired: Map<string, RetiredArtifact[]>,
    result: GdprExportRetentionResult,
  ): Promise<void> {
    for (const [orgId, entries] of retired) {
      const purgedIds: string[] = [];
      for (const entry of entries) {
        try {
          await this.storage.deleteFileIfPresent(orgId, entry.fileKey);
          purgedIds.push(entry.id);
          result.objectsDeleted += 1;
        } catch (err: unknown) {
          result.objectsOrphaned += 1;
          this.logger.error(
            "[gdpr-export-retention] subject export archive survived its expired job — orphan left in object storage",
            {
              orgId,
              key: entry.fileKey,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      if (purgedIds.length === 0) continue;

      for (let i = 0; i < purgedIds.length; i += UPDATE_CHUNK) {
        const chunk = purgedIds.slice(i, i + UPDATE_CHUNK);
        await withTenant(this.db, { orgId, audience: "INTERNAL" }, async (tx) => {
          await tx
            .update(gdprExportJobs)
            .set({ fileKey: null, updatedAt: new Date() })
            .where(
              and(
                eq(gdprExportJobs.orgId, orgId),
                inArray(gdprExportJobs.id, chunk),
              ),
            );
        });
      }
    }
  }

  private async auditLog(
    tx: TenantTx,
    orgId: string,
    reclaimed: number,
    expired: number,
    truncated: boolean,
    at: Date,
  ): Promise<void> {
    await tx.insert(hrAuditLogs).values({
      orgId,
      actorMembershipId: null,
      entityType: "gdpr_export_job_batch",
      entityId: "retention_sweep",
      action: "retention_sweep.gdpr_export_artifacts",
      after: {
        reclaimed,
        expired,
        truncated,
        at: at.toISOString(),
      } as Record<string, unknown>,
    });
  }
}
