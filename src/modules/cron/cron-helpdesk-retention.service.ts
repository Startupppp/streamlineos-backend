import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";
import { hrAuditLogs, helpdeskTickets } from "../../db/schema";

const BATCH_SIZE = 200;
const RETENTION_DAYS = 730;

export interface HelpdeskRetentionResult {
  organizations: number;
  ticketsDeleted: number;
}

@Injectable()
export class CronHelpdeskRetentionService {
  private readonly logger = new Logger(CronHelpdeskRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sweep(): Promise<HelpdeskRetentionResult> {
    const result: HelpdeskRetentionResult = { organizations: 0, ticketsDeleted: 0 };
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);

    const sweepResult = await forEachOrg(
      this.db,
      "helpdesk-retention",
      async (tx, orgId) => {
        const count = await this.sweepTickets(tx, orgId, cutoff);
        result.ticketsDeleted += count;
        if (count > 0)
          await this.auditLog(tx, orgId, count, cutoff);
      },
    );

    result.organizations = sweepResult.organizations;
    this.logger.log(
      `[helpdesk-retention] sweep complete: ${result.organizations} orgs, ` +
        `${result.ticketsDeleted} tickets deleted`,
    );
    return result;
  }

  private async sweepTickets(tx: TenantTx, orgId: string, cutoff: Date): Promise<number> {
    const rows = await tx
      .delete(helpdeskTickets)
      .where(
        sql`${helpdeskTickets.id} IN (
          SELECT id FROM helpdesk_tickets
          WHERE org_id = ${orgId}
            AND status IN ('RESOLVED', 'CLOSED')
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
    return rows.length;
  }

  private async auditLog(tx: TenantTx, orgId: string, count: number, cutoff: Date): Promise<void> {
    await tx.insert(hrAuditLogs).values({
      orgId,
      actorMembershipId: null,
      entityType: "helpdesk_ticket_batch",
      entityId: "retention_sweep",
      action: "retention_sweep.helpdesk_tickets",
      after: {
        count,
        cutoff: cutoff.toISOString(),
        retentionDays: RETENTION_DAYS,
      } as Record<string, unknown>,
    });
  }
}
