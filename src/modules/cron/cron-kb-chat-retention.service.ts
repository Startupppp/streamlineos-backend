import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { kbChatConversations, kbSettings } from "../../db/schema";
import { hrLegalHolds } from "../../db/schema/hr/governance";
import { organizationLegalHolds } from "../../db/schema/common/organization-purge";
import { organizationMembers } from "../../db/schema/common/auth";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";

const DEFAULT_RETENTION_DAYS = 90;
const BATCH_SIZE = 200;

export interface KbChatRetentionResult {
  orgsProcessed: number;
  conversationsDeleted: number;
}

@Injectable()
export class CronKbChatRetentionService {
  private readonly logger = new Logger(CronKbChatRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async purgeExpiredConversations(): Promise<KbChatRetentionResult> {
    let conversationsDeleted = 0;

    const result = await forEachOrg(this.db, "kb-chat-history-purge", async (tx, orgId) => {
      const retentionDays = await this.getRetentionDays(tx, orgId);
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
      conversationsDeleted += await this.purgeForOrg(tx, orgId, cutoff);
    });

    this.logger.log(
      `KB chat retention: deleted ${conversationsDeleted} conversations across ${result.succeeded} orgs`,
    );

    return { orgsProcessed: result.succeeded, conversationsDeleted };
  }

  private async getRetentionDays(tx: TenantTx, orgId: string): Promise<number> {
    const [row] = await tx
      .select({ chatHistoryRetentionDays: kbSettings.chatHistoryRetentionDays })
      .from(kbSettings)
      .where(eq(kbSettings.orgId, orgId))
      .limit(1);
    return row?.chatHistoryRetentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  private async purgeForOrg(tx: TenantTx, orgId: string, cutoff: Date): Promise<number> {
    let deleted = 0;
    for (;;) {
      const rows = await tx
        .select({ id: kbChatConversations.id })
        .from(kbChatConversations)
        .where(
          and(
            eq(kbChatConversations.orgId, orgId),
            lt(kbChatConversations.updatedAt, cutoff),
            sql`NOT EXISTS (
              SELECT 1
              FROM ${organizationLegalHolds}
              WHERE ${organizationLegalHolds.orgId} = ${kbChatConversations.orgId}
                AND ${organizationLegalHolds.releasedAt} IS NULL
            )`,
            sql`NOT EXISTS (
              SELECT 1
              FROM ${hrLegalHolds}
              WHERE ${hrLegalHolds.orgId} = ${kbChatConversations.orgId}
                AND ${hrLegalHolds.status} = 'active'
                AND ${hrLegalHolds.deletedAt} IS NULL
                AND (
                  ${hrLegalHolds.subjectMembershipId} = ${kbChatConversations.userMembershipId}
                  OR ${hrLegalHolds.subjectUserId} IN (
                    SELECT ${organizationMembers.userId}
                    FROM ${organizationMembers}
                    WHERE ${organizationMembers.orgId} = ${kbChatConversations.orgId}
                      AND ${organizationMembers.id} = ${kbChatConversations.userMembershipId}
                  )
                )
            )`,
          ),
        )
        .limit(BATCH_SIZE);
      if (rows.length === 0) break;
      await tx.delete(kbChatConversations).where(
        inArray(kbChatConversations.id, rows.map((r) => r.id)),
      );
      deleted += rows.length;
      if (rows.length < BATCH_SIZE) break;
    }
    return deleted;
  }
}
