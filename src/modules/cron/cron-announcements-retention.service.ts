import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";
import { announcements, hrAuditLogs } from "../../db/schema";

const BATCH_SIZE = 200;
const EXPIRED_GRACE_DAYS = 90;
const MAX_AGE_DAYS = 730;

export interface AnnouncementsRetentionResult {
  organizations: number;
  expiredDeleted: number;
  agedDeleted: number;
}

@Injectable()
export class CronAnnouncementsRetentionService {
  private readonly logger = new Logger(CronAnnouncementsRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sweep(): Promise<AnnouncementsRetentionResult> {
    const result: AnnouncementsRetentionResult = {
      organizations: 0,
      expiredDeleted: 0,
      agedDeleted: 0,
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
        result.expiredDeleted += expired;
        result.agedDeleted += aged;
        if (expired + aged > 0)
          await this.auditLog(tx, orgId, expired, aged, expiredCutoff, ageCutoff);
      },
    );

    result.organizations = sweepResult.organizations;
    this.logger.log(
      `[announcements-retention] sweep complete: ${result.organizations} orgs, ` +
        `${result.expiredDeleted} expired + ${result.agedDeleted} aged announcements deleted`,
    );
    return result;
  }

  private async sweepExpired(tx: TenantTx, orgId: string, cutoff: Date): Promise<number> {
    const rows = await tx
      .delete(announcements)
      .where(
        sql`${announcements.id} IN (
          SELECT id FROM announcements
          WHERE org_id = ${orgId}
            AND expires_at IS NOT NULL
            AND expires_at < ${cutoff}
          LIMIT ${BATCH_SIZE}
        )`,
      )
      .returning({ id: announcements.id });
    return rows.length;
  }

  private async sweepAged(tx: TenantTx, orgId: string, cutoff: Date): Promise<number> {
    const rows = await tx
      .delete(announcements)
      .where(
        sql`${announcements.id} IN (
          SELECT id FROM announcements
          WHERE org_id = ${orgId}
            AND created_at < ${cutoff}
          LIMIT ${BATCH_SIZE}
        )`,
      )
      .returning({ id: announcements.id });
    return rows.length;
  }

  private async auditLog(
    tx: TenantTx,
    orgId: string,
    expired: number,
    aged: number,
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
        expiredCutoff: expiredCutoff.toISOString(),
        ageCutoff: ageCutoff.toISOString(),
      } as Record<string, unknown>,
    });
  }
}
