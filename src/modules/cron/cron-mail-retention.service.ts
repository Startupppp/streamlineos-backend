import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";
import { hrAuditLogs, mailMessageMetadata } from "../../db/schema";

const BATCH_SIZE = 500;
const MAX_BATCHES = 100;
const RETENTION_DAYS = 365;

export interface MailRetentionResult {
  organizations: number;
  organizationsFailed: number;
  rowsDeleted: number;
  truncated: boolean;
}

@Injectable()
export class CronMailRetentionService {
  private readonly logger = new Logger(CronMailRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sweep(): Promise<MailRetentionResult> {
    const result: MailRetentionResult = {
      organizations: 0,
      organizationsFailed: 0,
      rowsDeleted: 0,
      truncated: false,
    };
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);

    const sweepResult = await forEachOrg(
      this.db,
      "mail-metadata-retention",
      async (tx, orgId) => {
        const { deleted, truncated } = await this.sweepMetadata(tx, orgId, cutoff);
        result.rowsDeleted += deleted;
        if (truncated) result.truncated = true;
        if (deleted > 0) await this.auditLog(tx, orgId, deleted, truncated, cutoff);
      },
    );

    result.organizations = sweepResult.organizations;
    result.organizationsFailed = sweepResult.failed;
    this.logger.log(
      `[mail-retention] sweep complete: ${result.organizations} orgs ` +
        `(${result.organizationsFailed} failed), ${result.rowsDeleted} mail metadata rows deleted ` +
        `truncated=${result.truncated}`,
    );
    return result;
  }

  private async auditLog(
    tx: TenantTx,
    orgId: string,
    count: number,
    truncated: boolean,
    cutoff: Date,
  ): Promise<void> {
    await tx.insert(hrAuditLogs).values({
      orgId,
      actorMembershipId: null,
      entityType: "mail_message_metadata_batch",
      entityId: "retention_sweep",
      action: "retention_sweep.mail_message_metadata",
      after: {
        count,
        truncated,
        cutoff: cutoff.toISOString(),
        retentionDays: RETENTION_DAYS,
      } as Record<string, unknown>,
    });
  }

  /**
   * Drains until a short batch proves the backlog is exhausted. Stopping after one
   * batch let a tenant that produces more than BATCH_SIZE rows per tick accumulate
   * for ever while the sweep reported success; `truncated` says the cap was hit.
   */
  private async sweepMetadata(
    tx: TenantTx,
    orgId: string,
    cutoff: Date,
  ): Promise<{ deleted: number; truncated: boolean }> {
    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const rows = await tx
        .delete(mailMessageMetadata)
        .where(
          sql`${mailMessageMetadata.id} IN (
            SELECT id FROM mail_message_metadata
            WHERE org_id = ${orgId}
              AND synced_at < ${cutoff}
              AND (user_membership_id IS NULL OR user_membership_id NOT IN (
                SELECT m.id FROM organization_members m
                WHERE m.org_id = ${orgId}
                  AND m.user_id IN (
                    SELECT subject_user_id FROM hr_legal_holds
                    WHERE org_id = ${orgId}
                      AND status = 'active'
                      AND deleted_at IS NULL
                      AND subject_user_id IS NOT NULL
                  )
              ))
            LIMIT ${BATCH_SIZE}
          )`,
        )
        .returning({ id: mailMessageMetadata.id });
      deleted += rows.length;
      if (rows.length < BATCH_SIZE) return { deleted, truncated: false };
    }
    this.logger.warn(
      `[mail-retention] org ${orgId} hit the ${MAX_BATCHES}-batch cap with rows still eligible — the next tick resumes`,
    );
    return { deleted, truncated: true };
  }
}
