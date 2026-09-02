import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";
import { hrAuditLogs, mailMessageMetadata } from "../../db/schema";

const BATCH_SIZE = 500;
const RETENTION_DAYS = 365;

export interface MailRetentionResult {
  organizations: number;
  rowsDeleted: number;
}

@Injectable()
export class CronMailRetentionService {
  private readonly logger = new Logger(CronMailRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sweep(): Promise<MailRetentionResult> {
    const result: MailRetentionResult = { organizations: 0, rowsDeleted: 0 };
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);

    const sweepResult = await forEachOrg(
      this.db,
      "mail-metadata-retention",
      async (tx, orgId) => {
        const count = await this.sweepMetadata(tx, orgId, cutoff);
        result.rowsDeleted += count;
        if (count > 0) await this.auditLog(tx, orgId, count, cutoff);
      },
    );

    result.organizations = sweepResult.organizations;
    this.logger.log(
      `[mail-retention] sweep complete: ${result.organizations} orgs, ` +
        `${result.rowsDeleted} mail metadata rows deleted`,
    );
    return result;
  }

  private async auditLog(tx: TenantTx, orgId: string, count: number, cutoff: Date): Promise<void> {
    await tx.insert(hrAuditLogs).values({
      orgId,
      actorMembershipId: null,
      entityType: "mail_message_metadata_batch",
      entityId: "retention_sweep",
      action: "retention_sweep.mail_message_metadata",
      after: {
        count,
        cutoff: cutoff.toISOString(),
        retentionDays: RETENTION_DAYS,
      } as Record<string, unknown>,
    });
  }

  private async sweepMetadata(tx: TenantTx, orgId: string, cutoff: Date): Promise<number> {
    const rows = await tx
      .delete(mailMessageMetadata)
      .where(
        sql`${mailMessageMetadata.id} IN (
          SELECT id FROM mail_message_metadata
          WHERE org_id = ${orgId}
            AND synced_at < ${cutoff}
          LIMIT ${BATCH_SIZE}
        )`,
      )
      .returning({ id: mailMessageMetadata.id });
    return rows.length;
  }
}
