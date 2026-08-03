import { Inject, Injectable } from "@nestjs/common";
import { and, eq, lt, lte } from "drizzle-orm";
import { invitations, organizations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { AuditService } from "../../common/audit/audit.service";
import { forEachOrg } from "../../common/tenant";

@Injectable()
export class CronOrganizationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async expireStaleInvitations(): Promise<{ expired: number }> {
    const now = new Date();
    let expired = 0;

    await forEachOrg(this.db, "org-expire-invitations", async (tx, orgId) => {
      const result = await tx
        .update(invitations)
        .set({ status: "EXPIRED" })
        .where(
          and(
            eq(invitations.orgId, orgId),
            eq(invitations.status, "PENDING"),
            lt(invitations.expiresAt, now),
          ),
        )
        .returning({ id: invitations.id });
      expired += result.length;
    });

    return { expired };
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
