import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";
import { hrAuditLogs, helpdeskTickets } from "../../db/schema";

const BATCH_SIZE = 200;
const MAX_BATCHES = 100;
const RETENTION_DAYS = 730;

export interface HelpdeskRetentionResult {
  organizations: number;
  organizationsFailed: number;
  ticketsDeleted: number;
  truncated: boolean;
}

@Injectable()
export class CronHelpdeskRetentionService {
  private readonly logger = new Logger(CronHelpdeskRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sweep(): Promise<HelpdeskRetentionResult> {
    const result: HelpdeskRetentionResult = {
      organizations: 0,
      organizationsFailed: 0,
      ticketsDeleted: 0,
      truncated: false,
    };
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);

    const sweepResult = await forEachOrg(
      this.db,
      "helpdesk-retention",
      async (tx, orgId) => {
        const { deleted, truncated } = await this.sweepTickets(tx, orgId, cutoff);
        result.ticketsDeleted += deleted;
        if (truncated) result.truncated = true;
        if (deleted > 0) await this.auditLog(tx, orgId, deleted, truncated, cutoff);
      },
    );

    result.organizations = sweepResult.organizations;
    result.organizationsFailed = sweepResult.failed;
    this.logger.log(
      `[helpdesk-retention] sweep complete: ${result.organizations} orgs ` +
        `(${result.organizationsFailed} failed), ${result.ticketsDeleted} tickets deleted ` +
        `truncated=${result.truncated}`,
    );
    return result;
  }

  /**
   * Drains until a short batch proves the backlog is exhausted. Stopping after one
   * batch let a tenant that resolves more than BATCH_SIZE tickets per tick accumulate
   * for ever while the sweep reported success; `truncated` says the cap was hit.
   */
  private async sweepTickets(
    tx: TenantTx,
    orgId: string,
    cutoff: Date,
  ): Promise<{ deleted: number; truncated: boolean }> {
    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const rows = await tx
        .delete(helpdeskTickets)
        .where(
          sql`${helpdeskTickets.id} IN (
            SELECT id FROM helpdesk_tickets
            WHERE org_id = ${orgId}
              AND status = 'DONE'
              AND resolved_at IS NOT NULL
              AND resolved_at < ${cutoff}
              AND (user_id IS NULL OR user_id NOT IN (
                SELECT subject_user_id FROM hr_legal_holds
                WHERE org_id = ${orgId}
                  AND status = 'active'
                  AND deleted_at IS NULL
                  AND subject_user_id IS NOT NULL
              ))
            LIMIT ${BATCH_SIZE}
          )`,
        )
        .returning({ id: helpdeskTickets.id });
      deleted += rows.length;
      if (rows.length < BATCH_SIZE) return { deleted, truncated: false };
    }
    this.logger.warn(
      `[helpdesk-retention] org ${orgId} hit the ${MAX_BATCHES}-batch cap with rows still eligible — the next tick resumes`,
    );
    return { deleted, truncated: true };
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
      entityType: "helpdesk_ticket_batch",
      entityId: "retention_sweep",
      action: "retention_sweep.helpdesk_tickets",
      after: {
        count,
        truncated,
        cutoff: cutoff.toISOString(),
        retentionDays: RETENTION_DAYS,
      } as Record<string, unknown>,
    });
  }
}
