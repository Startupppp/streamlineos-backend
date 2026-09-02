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
import { StorageService } from "../storage/storage.service";
import {
  PURGE_ADAPTERS,
  PURGE_ADAPTER_REGISTRY,
  type PurgeAdapterResult,
} from "../organization/core/lifecycle/organization-purge-adapters";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { assertNever } from "../../common/auth/principal";

const BATCH_SIZE = 20;

type PurgeOutcome =
  | { kind: "purged" }
  | { kind: "legal-hold" }
  | { kind: "not-scheduled" }
  | { kind: "adapters-incomplete"; adapters: Record<string, string> }
  | { kind: "claimed-elsewhere" };

@Injectable()
export class CronOrgPurgeWorkerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly orgMembership: OrgMembershipService,
    private readonly storage: StorageService,
  ) {}

  async run(): Promise<{ processed: number; skipped: number; moreRemaining: boolean }> {
    const now = new Date();

    // BATCH_SIZE + 1 so the overflow is counted rather than inferred: the sweep is
    // self-resuming, but a caller could not tell a cleared queue from a capped one.
    const probed = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.statusV2, "PURGE_SCHEDULED"),
          isNotNull(organizations.purgeScheduledAt),
          lte(organizations.purgeScheduledAt, now),
        ),
      )
      .limit(BATCH_SIZE + 1);

    const moreRemaining = probed.length > BATCH_SIZE;
    const candidates = moreRemaining ? probed.slice(0, BATCH_SIZE) : probed;

    if (candidates.length === 0) return { processed: 0, skipped: 0, moreRemaining: false };

    let processed = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      logger.info("[cron-org-purge] attempting purge", { orgId: candidate.id });
      try {
        const outcome = await this.purgeSingle(candidate.id);
        if (outcome.kind === "purged") {
          processed++;
          logger.info("[cron-org-purge] purge succeeded", { orgId: candidate.id });
        } else {
          skipped++;
          this.logSkip(candidate.id, outcome);
        }
      } catch (err) {
        skipped++;
        logger.error("[cron-org-purge] purge failed", { orgId: candidate.id, err });
      }
    }

    return { processed, skipped, moreRemaining };
  }

  private logSkip(orgId: string, outcome: Exclude<PurgeOutcome, { kind: "purged" }>): void {
    switch (outcome.kind) {
      case "legal-hold":
        logger.warn("[cron-org-purge] purge blocked by an active legal hold", { orgId });
        return;
      case "adapters-incomplete":
        logger.warn(
          "[cron-org-purge] adapter confirmations incomplete; org remains in PURGE_SCHEDULED",
          { orgId, adapters: outcome.adapters },
        );
        return;
      case "not-scheduled":
        logger.info("[cron-org-purge] purge skipped; org is no longer purge-scheduled", {
          orgId,
        });
        return;
      case "claimed-elsewhere":
        logger.info("[cron-org-purge] purge skipped; claimed by another instance", { orgId });
        return;
      default:
        return assertNever(outcome);
    }
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

  private async purgeSingle(orgId: string): Promise<PurgeOutcome> {
    const legalHold = await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({ holdId: organizationLegalHolds.holdId })
        .from(organizationLegalHolds)
        .where(
          and(
            eq(organizationLegalHolds.orgId, orgId),
            isNull(organizationLegalHolds.releasedAt),
          ),
        )
        .limit(1);
      return row;
    });

    if (legalHold) return { kind: "legal-hold" };

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

    if (!org) return { kind: "not-scheduled" };

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
          this.storage,
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

    const adapterStates = Object.fromEntries(
      Object.entries(adapterResults).map(([name, result]) => [name, result.state]),
    );

    if (!allConfirmed) return { kind: "adapters-incomplete", adapters: adapterStates };

    const memberUserIds = await this.listMemberUserIds(orgId);
    const purged = await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id FROM organizations
        WHERE  id          = ${orgId}
          AND  status_v2   = 'PURGE_SCHEDULED'
          AND  purge_scheduled_at IS NOT NULL
          AND  purge_scheduled_at <= NOW()
        FOR UPDATE SKIP LOCKED
      `);

      if (!rows[0]) return false;

      // audit_logs is retained as platform evidence, while every other
      // organization-owned row is removed by the database FK cascade.
      await tx.execute(sql`SELECT app.nullify_audit_logs_org_id(${orgId})`);
      await tx.delete(organizations).where(eq(organizations.id, orgId));

      return true;
    });

    if (!purged) return { kind: "claimed-elsewhere" };

    await this.revokeAndBustMembers(orgId, memberUserIds);
    this.audit.log({
      action: "org.purged",
      userId: "system",
      orgId: null,
      targetId: orgId,
      targetType: "organization",
      metadata: { orgName, purgeJobId, physicalDeletion: true },
    });
    return { kind: "purged" };
  }
}
