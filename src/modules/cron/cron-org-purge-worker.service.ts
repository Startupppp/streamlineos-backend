import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { organizationLegalHolds, organizationMembers, organizationPurgeConfirmations, organizations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { bustMembershipStatusCache } from "../../common/auth/membership-state.service";
import { OrgMembershipService } from "../organization/core/org-membership.service";
import {
  PURGE_ADAPTERS,
  PURGE_ADAPTER_REGISTRY,
  type PurgeAdapterResult,
} from "../organization/core/lifecycle/organization-purge-adapters";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

const BATCH_SIZE = 20;

@Injectable()
export class CronOrgPurgeWorkerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly orgMembership: OrgMembershipService,
  ) {}

  async run(): Promise<{ processed: number; skipped: number }> {
    const now = new Date();

    const candidates = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.statusV2, "PURGE_SCHEDULED"),
          isNotNull(organizations.purgeScheduledAt),
          lte(organizations.purgeScheduledAt, now),
        ),
      )
      .limit(BATCH_SIZE);

    if (candidates.length === 0) return { processed: 0, skipped: 0 };

    let processed = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      logger.info("[cron-org-purge] attempting purge", { orgId: candidate.id });
      try {
        const purged = await this.purgeSingle(candidate.id);
        if (purged) {
          processed++;
          logger.info("[cron-org-purge] purge succeeded", { orgId: candidate.id });
        } else {
          skipped++;
          logger.info("[cron-org-purge] purge skipped (claimed by another instance or state changed)", {
            orgId: candidate.id,
          });
        }
      } catch (err) {
        skipped++;
        logger.error("[cron-org-purge] purge failed", { orgId: candidate.id, err });
      }
    }

    return { processed, skipped };
  }

  private async listMemberUserIds(orgId: string): Promise<string[]> {
    const members = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));
    return members.map((m) => m.userId);
  }

  private async revokeAndBustMembers(orgId: string, memberUserIds: string[]): Promise<void> {
    for (const memberUserId of memberUserIds) {
      await this.orgMembership.revokeOrgScopedAccess(orgId, memberUserId, "removed");
    }
    await Promise.all(
      memberUserIds.map((memberUserId) =>
        Promise.all([
          bustMembershipStatusCache(this.cache, memberUserId, orgId),
          this.cache.invalidate(CACHE_KEYS.userSession(memberUserId)),
        ]),
      ),
    );
  }

  private async purgeSingle(orgId: string): Promise<boolean> {
    const [legalHold] = await this.db
      .select({ holdId: organizationLegalHolds.holdId })
      .from(organizationLegalHolds)
      .where(
        and(
          eq(organizationLegalHolds.orgId, orgId),
          isNull(organizationLegalHolds.releasedAt),
        ),
      )
      .limit(1);

    if (legalHold) {
      logger.info("[cron-org-purge] purge blocked by active legal hold", { orgId });
      return false;
    }

    const now = new Date();
    const [org] = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        purgeJobId: organizations.purgeJobId,
      })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.statusV2, "PURGE_SCHEDULED"),
          isNotNull(organizations.purgeScheduledAt),
          lte(organizations.purgeScheduledAt, now),
        ),
      )
      .limit(1);

    if (!org) return false;

    const purgeJobId = org.purgeJobId ?? orgId;
    const orgName = org.name;

    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      for (const adapter of PURGE_ADAPTERS) {
        await tx
          .insert(organizationPurgeConfirmations)
          .values({ orgId, purgeJobId, adapter, state: "PENDING" })
          .onConflictDoNothing();
      }
    });

    const adapterResults: Record<string, PurgeAdapterResult> = {};
    for (const adapter of PURGE_ADAPTERS) {
      try {
        adapterResults[adapter] = await PURGE_ADAPTER_REGISTRY[adapter].confirm(
          orgId,
          purgeJobId,
          this.db,
        );
      } catch (err) {
        adapterResults[adapter] = { state: "FAILED", detail: String(err) };
      }
    }

    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      for (const adapter of PURGE_ADAPTERS) {
        const result = adapterResults[adapter];
        await tx
          .update(organizationPurgeConfirmations)
          .set({
            state: result.state,
            detail: result.detail,
            confirmedAt: result.state === "CONFIRMED" ? new Date() : null,
          })
          .where(
            and(
              eq(organizationPurgeConfirmations.orgId, orgId),
              eq(organizationPurgeConfirmations.purgeJobId, purgeJobId),
              eq(organizationPurgeConfirmations.adapter, adapter),
            ),
          );
      }
    });

    const allConfirmed = PURGE_ADAPTERS.every((adapter) => {
      const state = adapterResults[adapter]?.state;
      return state === "CONFIRMED" || state === "NOT_APPLICABLE";
    });

    if (!allConfirmed) {
      // A warning, not info: until the unimplemented adapters land this fires for
      // every scheduled purge, and a purge that never completes must be visible.
      logger.warn("[cron-org-purge] adapter confirmations incomplete; org remains in PURGE_SCHEDULED", {
        orgId,
        adapters: Object.fromEntries(
          Object.entries(adapterResults).map(([k, v]) => [k, v.state]),
        ),
      });
      return false;
    }

    const purged = await this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id FROM organizations
        WHERE  id          = ${orgId}
          AND  status_v2   = 'PURGE_SCHEDULED'
          AND  purge_scheduled_at IS NOT NULL
          AND  purge_scheduled_at <= NOW()
        FOR UPDATE SKIP LOCKED
      `);

      if (!rows[0]) return false;

      await tx
        .update(organizations)
        .set({ statusV2: "PURGED", status: "PURGED", purgedAt: new Date() })
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
        metadata: { orgName, purgeJobId },
      });

      return true;
    });

    if (purged) {
      const memberUserIds = await this.listMemberUserIds(orgId);
      await this.revokeAndBustMembers(orgId, memberUserIds);
    }

    return purged;
  }
}
