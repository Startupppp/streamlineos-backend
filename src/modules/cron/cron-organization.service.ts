import { Inject, Injectable } from "@nestjs/common";
import { and, eq, lt, lte } from "drizzle-orm";
import { invitations, organizations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { AuditService } from "../../common/audit/audit.service";

@Injectable()
export class CronOrganizationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async expireStaleInvitations(): Promise<{ expired: number }> {
    const now = new Date();
    const result = await this.db
      .update(invitations)
      .set({ status: "EXPIRED" })
      .where(
        and(
          eq(invitations.status, "PENDING"),
          lt(invitations.expiresAt, now),
        ),
      )
      .returning({ id: invitations.id });
    return { expired: result.length };
  }

  async runPurgeWorker(): Promise<{ processed: number; skipped: number }> {
    const now = new Date();
    const due = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        statusV2: organizations.statusV2,
      })
      .from(organizations)
      .where(
        and(
          eq(organizations.statusV2, "PURGE_SCHEDULED"),
          lte(organizations.purgeScheduledAt, now),
        ),
      )
      .limit(50);

    let processed = 0;
    let skipped = 0;

    for (const org of due) {
      if (org.statusV2 === "PURGED") {
        skipped++;
        continue;
      }
      try {
        await this.executePurge(org.id, org.name);
        processed++;
      } catch (err) {
        logger.error("[cron-org] purge failed", { orgId: org.id, err });
        skipped++;
      }
    }

    return { processed, skipped };
  }

  private async executePurge(orgId: string, orgName: string): Promise<void> {
    // TODO: cascade deletion of all tenant data (members, tickets, etc.) is a follow-up.
    // For this first cut, mark the org as PURGED and log; data remains intact.
    await this.db
      .update(organizations)
      .set({ statusV2: "PURGED", purgedAt: new Date() })
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.statusV2, "PURGE_SCHEDULED"),
        ),
      );

    this.audit.log({
      action: "org.purged",
      userId: "system",
      orgId,
      targetId: orgId,
      targetType: "organization",
      metadata: { orgName },
    });
  }
}
