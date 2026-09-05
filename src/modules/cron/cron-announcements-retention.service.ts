import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";
import { announcements, hrAuditLogs } from "../../db/schema";

const BATCH_SIZE = 200;
const MAX_BATCHES = 100;
const EXPIRED_GRACE_DAYS = 90;
const MAX_AGE_DAYS = 730;

export interface AnnouncementsRetentionResult {
  organizations: number;
  organizationsFailed: number;
  expiredDeleted: number;
  agedDeleted: number;
  truncated: boolean;
}

interface BatchDrainResult {
  count: number;
  truncated: boolean;
}

@Injectable()
export class CronAnnouncementsRetentionService {
  private readonly logger = new Logger(CronAnnouncementsRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sweep(): Promise<AnnouncementsRetentionResult> {
    const result: AnnouncementsRetentionResult = {
      organizations: 0,
      organizationsFailed: 0,
      expiredDeleted: 0,
      agedDeleted: 0,
      truncated: false,
    };
    const now = new Date();
    const expiredCutoff = new Date(now.getTime() - EXPIRED_GRACE_DAYS * 24 * 3600 * 1000);
    const ageCutoff = new Date(now.getTime() - MAX_AGE_DAYS * 24 * 3600 * 1000);

    const sweepResult = await forEachOrg(
      this.db,
      "announcements-retention",
      async (tx, orgId) => {
        const expired = await this.sweepExpired(tx, orgId, expiredCutoff);
        const aged = await this.sweepAged(tx, orgId, ageCutoff);
        result.expiredDeleted += expired.count;
        result.agedDeleted += aged.count;
        const truncated = expired.truncated || aged.truncated;
        if (truncated) result.truncated = true;
        if (expired.count + aged.count > 0)
          await this.auditLog(
            tx,
            orgId,
            expired.count,
            aged.count,
            truncated,
            expiredCutoff,
            ageCutoff,
          );
      },
    );

    result.organizations = sweepResult.organizations;
    result.organizationsFailed = sweepResult.failed;
    this.logger.log(
      `[announcements-retention] sweep complete: ${result.organizations} orgs ` +
        `(${result.organizationsFailed} failed), ${result.expiredDeleted} expired + ` +
        `${result.agedDeleted} aged announcements deleted truncated=${result.truncated}`,
    );
    return result;
  }

  private async sweepExpired(
    tx: TenantTx,
    orgId: string,
    cutoff: Date,
  ): Promise<BatchDrainResult> {
    return this.drain(orgId, "expired", (limit) =>
      tx
        .delete(announcements)
        .where(
          sql`${announcements.id} IN (
            SELECT id FROM announcements
            WHERE org_id = ${orgId}
              AND expires_at IS NOT NULL
              AND expires_at < ${cutoff}
              AND author_id NOT IN (
                SELECT subject_user_id FROM hr_legal_holds
                WHERE org_id = ${orgId}
                  AND status = 'active'
                  AND deleted_at IS NULL
                  AND subject_user_id IS NOT NULL
              )
            LIMIT ${limit}
          )`,
        )
        .returning({ id: announcements.id })
        .then((rows) => rows.length),
    );
  }

  private async sweepAged(
    tx: TenantTx,
    orgId: string,
    cutoff: Date,
  ): Promise<BatchDrainResult> {
    return this.drain(orgId, "aged", (limit) =>
      tx
        .delete(announcements)
        .where(
          sql`${announcements.id} IN (
            SELECT id FROM announcements
            WHERE org_id = ${orgId}
              AND created_at < ${cutoff}
              AND author_id NOT IN (
                SELECT subject_user_id FROM hr_legal_holds
                WHERE org_id = ${orgId}
                  AND status = 'active'
                  AND deleted_at IS NULL
                  AND subject_user_id IS NOT NULL
              )
            LIMIT ${limit}
          )`,
        )
        .returning({ id: announcements.id })
        .then((rows) => rows.length),
    );
  }

  /**
   * Drains until a short batch proves the phase is exhausted. Stopping after one
   * batch let a tenant that expires more than BATCH_SIZE announcements per tick
   * accumulate for ever while the sweep reported success; `truncated` says the cap
   * was hit and the next tick still has work.
   */
  private async drain(
    orgId: string,
    phase: "expired" | "aged",
    run: (limit: number) => Promise<number>,
  ): Promise<BatchDrainResult> {
    let count = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const affected = await run(BATCH_SIZE);
      count += affected;
      if (affected < BATCH_SIZE) return { count, truncated: false };
    }
    this.logger.warn(
      `[announcements-retention] org ${orgId} ${phase} phase hit the ${MAX_BATCHES}-batch cap ` +
        `with rows still eligible — the next tick resumes`,
    );
    return { count, truncated: true };
  }

  private async auditLog(
    tx: TenantTx,
    orgId: string,
    expired: number,
    aged: number,
    truncated: boolean,
    expiredCutoff: Date,
    ageCutoff: Date,
  ): Promise<void> {
    await tx.insert(hrAuditLogs).values({
      orgId,
      actorMembershipId: null,
      entityType: "announcement_batch",
      entityId: "retention_sweep",
      action: "retention_sweep.announcements",
      after: {
        expiredDeleted: expired,
        agedDeleted: aged,
        truncated,
        expiredCutoff: expiredCutoff.toISOString(),
        ageCutoff: ageCutoff.toISOString(),
      } as Record<string, unknown>,
    });
  }
}
