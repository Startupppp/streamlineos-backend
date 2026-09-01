import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  accountOrganizationIndex,
  candidateOffers,
  leaveBlackoutDates,
  onboardingTasks,
  organizationLegalHolds,
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { assertTransitionAllowed } from "./lifecycle/organization-lifecycle-transitions";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { bustMembershipStatusCache } from "../../../common/auth/membership-state.service";
import { OrgMembershipService } from "./org-membership.service";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { withIdentity } from "../../../common/tenant/with-identity";
import { unplaceOrganization } from "../../../common/region/placement-lookup";
import {
  getRegionRegistry,
  hasRegionRegistry,
} from "../../../common/region/region-registry";
import { OrganizationSagaService } from "./lifecycle/organization-saga.service";

@Injectable()
export class OrgPurgeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly orgMembership: OrgMembershipService,
    private readonly saga: OrganizationSagaService,
  ) {}

  private async hasActiveLegalHold(
    orgId: string,
    db: DbOrTx = this.db,
  ): Promise<boolean> {
    const [hold] = await db
      .select({ holdId: organizationLegalHolds.holdId })
      .from(organizationLegalHolds)
      .where(
        and(
          eq(organizationLegalHolds.orgId, orgId),
          isNull(organizationLegalHolds.releasedAt),
        ),
      )
      .limit(1);
    return hold !== undefined;
  }

  private async listMemberUserIds(db: DbOrTx, orgId: string): Promise<string[]> {
    const members = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId))
      .limit(10000);
    return members.map((m) => m.userId);
  }

  private async bustMembersMembership(orgId: string, memberUserIds: string[]): Promise<void> {
    await Promise.all(
      memberUserIds.map((memberUserId) =>
        Promise.all([
          bustMembershipStatusCache(this.cache, memberUserId, orgId),
          this.cache.invalidate(CACHE_KEYS.userSession(memberUserId)),
        ]),
      ),
    );
  }

  private async revokeMembersAccess(orgId: string, memberUserIds: string[]): Promise<void> {
    for (const memberUserId of memberUserIds) {
      await this.orgMembership.revokeOrgScopedAccess(orgId, memberUserId, "removed");
    }
  }

  private async findNextActiveOrgId(
    db: DbOrTx,
    userId: string,
    excludeOrgId: string,
  ): Promise<string | null> {
    const [remaining] = await db
      .select({ orgId: organizationMembers.orgId })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(
        and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "ACTIVE"),
          eq(organizations.status, "ACTIVE"),
          isNull(organizations.deletedAt),
          ne(organizationMembers.orgId, excludeOrgId),
        ),
      )
      .orderBy(desc(organizationMembers.joinedAt))
      .limit(1);
    return remaining?.orgId ?? null;
  }

  private async resolveReplacementOrgIds(
    orgId: string,
    memberUserIds: string[],
  ): Promise<Map<string, string | null>> {
    const replacements = new Map<string, string | null>();
    for (const memberUserId of memberUserIds) {
      const nextOrgId = await withIdentity(this.db, memberUserId, (tx) =>
        this.findNextActiveOrgId(tx, memberUserId, orgId),
      );
      replacements.set(memberUserId, nextOrgId);
    }
    return replacements;
  }

  private async repairLastActiveOrgIds(
    db: DbOrTx,
    orgId: string,
    replacements: Map<string, string | null>,
  ): Promise<void> {
    for (const [memberUserId, nextOrgId] of replacements) {
      await db
        .update(users)
        .set({ lastActiveOrgId: nextOrgId })
        .where(
          and(
            eq(users.id, memberUserId),
            eq(users.lastActiveOrgId, orgId),
          ),
        );
      await db
        .update(accountOrganizationIndex)
        .set({ organizationStatus: "ARCHIVED" })
        .where(
          and(
            eq(accountOrganizationIndex.userId, memberUserId),
            eq(accountOrganizationIndex.orgId, orgId),
          ),
        );
    }
  }

  async deleteOrg(orgId: string, userId: string, confirmation: string) {
    const [org] = await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .select({
            id: organizations.id,
            name: organizations.name,
            slug: organizations.slug,
            statusV2: organizations.statusV2,
          })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1),
      { orgId },
    );
    if (!org) throw new NotFoundException("Organization not found");

    const activeLegalHold = await this.hasActiveLegalHold(orgId);
    const transition = assertTransitionAllowed(
      "TERMINAL_DELETE",
      org.statusV2 ?? "ACTIVE",
      { hasActiveLegalHold: activeLegalHold },
    );
    if (!transition.allowed) throw new BadRequestException(transition.reason);

    const provided = confirmation.trim().toLowerCase();
    const matches =
      provided === org.name.trim().toLowerCase() ||
      (org.slug ? provided === org.slug.trim().toLowerCase() : false);
    if (!matches) {
      throw new BadRequestException(
        "Confirmation text does not match the organization name",
      );
    }

    const sagaCtx = await this.saga.begin(
      "TERMINAL_DELETE",
      orgId,
      `terminal-delete:${orgId}:${userId}`,
      userId,
      org.statusV2 ?? "ACTIVE",
    );
    const done = new Set(
      sagaCtx.steps.filter((s) => s.state === "DONE").map((s) => s.stepName),
    );

    let nextOrgId: string | null = null;
    try {
      if (!done.has("validate-confirmation"))
        await this.saga.runStep(
          sagaCtx.saga.sagaId,
          "validate-confirmation",
          () => Promise.resolve(),
        );

      if (!done.has("validate-no-legal-hold"))
        await this.saga.runStep(
          sagaCtx.saga.sagaId,
          "validate-no-legal-hold",
          () => Promise.resolve(),
        );

      if (!done.has("delete-org-data"))
        nextOrgId = await this.saga.runStep(
          sagaCtx.saga.sagaId,
          "delete-org-data",
          async () => {
            const memberUserIds = await runInTenantTransaction(
              this.db,
              (tx) => this.listMemberUserIds(tx, orgId),
              { orgId },
            );
            const replacements = await this.resolveReplacementOrgIds(orgId, memberUserIds);
            const next = replacements.get(userId) ?? null;
            await runInTenantTransaction(
              this.db,
              async (tx) => {
                await this.repairLastActiveOrgIds(tx, orgId, replacements);
                await tx.delete(candidateOffers).where(eq(candidateOffers.orgId, orgId));
                await tx
                  .delete(leaveBlackoutDates)
                  .where(eq(leaveBlackoutDates.orgId, orgId));
                await tx.delete(onboardingTasks).where(eq(onboardingTasks.orgId, orgId));
                await tx.execute(sql`SELECT app.nullify_audit_logs_org_id(${orgId})`);
                await tx.delete(organizations).where(eq(organizations.id, orgId));
              },
              { orgId },
            );
            await this.revokeMembersAccess(orgId, memberUserIds);
            await this.bustMembersMembership(orgId, memberUserIds);
            return next;
          },
        );

      if (!done.has("remove-placement"))
        await this.saga.runStep(sagaCtx.saga.sagaId, "remove-placement", async () => {
          await unplaceOrganization(this.db, orgId);
          if (hasRegionRegistry()) getRegionRegistry().forget(orgId);
        });

      await this.saga.complete(sagaCtx.saga.sagaId);
    } catch (err) {
      await this.saga.compensate(sagaCtx.saga.sagaId, {});
      throw err;
    }

    this.audit.log({
      action: "org.deleted",
      userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
      metadata: { name: org.name },
    });
    return { success: true as const, nextOrgId };
  }

  async schedulePurge(
    orgId: string,
    actorUserId: string,
    scheduledForDays: number,
    reason: string,
  ): Promise<{ success: true; purgeJobId: string; purgeScheduledAt: Date }> {
    const [org] = await this.db
      .select({ id: organizations.id, statusV2: organizations.statusV2 })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new NotFoundException("Organization not found");
    if (org.statusV2 === "PURGED") {
      throw new BadRequestException("Organization is already purged");
    }

    const activeLegalHoldForPurge = await this.hasActiveLegalHold(orgId);
    const purgeTransition = assertTransitionAllowed(
      "PURGE_SCHEDULE",
      org.statusV2 ?? "ACTIVE",
      { hasActiveLegalHold: activeLegalHoldForPurge },
    );
    if (!purgeTransition.allowed) throw new BadRequestException(purgeTransition.reason);

    const purgeJobId = randomUUID();
    const purgeScheduledAt = new Date(Date.now() + scheduledForDays * 24 * 60 * 60 * 1000);

    const sagaCtx = await this.saga.begin(
      "PURGE_SCHEDULE",
      orgId,
      `purge-schedule:${orgId}:${actorUserId}`,
      actorUserId,
      org.statusV2 ?? "ACTIVE",
    );
    const done = new Set(
      sagaCtx.steps.filter((s) => s.state === "DONE").map((s) => s.stepName),
    );

    try {
      if (!done.has("validate-no-legal-hold"))
        await this.saga.runStep(
          sagaCtx.saga.sagaId,
          "validate-no-legal-hold",
          () => Promise.resolve(),
        );

      if (!done.has("set-status-purge-scheduled"))
        await this.saga.runStep(
          sagaCtx.saga.sagaId,
          "set-status-purge-scheduled",
          () =>
            runInTenantTransaction(
              this.db,
              (tx) =>
                tx
                  .update(organizations)
                  .set({
                    statusV2: "PURGE_SCHEDULED",
                    purgeScheduledAt,
                    purgeScheduledBy: actorUserId,
                    purgeReason: reason,
                    purgeJobId,
                  })
                  .where(eq(organizations.id, orgId)),
              { orgId },
            ),
        );

      await this.saga.complete(sagaCtx.saga.sagaId);
    } catch (err) {
      await this.saga.compensate(sagaCtx.saga.sagaId, {});
      throw err;
    }

    this.audit.log({
      action: "org.purge_scheduled",
      userId: actorUserId,
      orgId,
      targetId: orgId,
      targetType: "organization",
      metadata: { purgeJobId, purgeScheduledAt, reason },
    });

    return { success: true, purgeJobId, purgeScheduledAt };
  }

  async cancelPurge(orgId: string, actorUserId: string): Promise<{ success: true }> {
    const [org] = await this.db
      .select({ id: organizations.id, statusV2: organizations.statusV2 })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new NotFoundException("Organization not found");
    if (org.statusV2 !== "PURGE_SCHEDULED") {
      throw new BadRequestException("No purge is scheduled for this organization");
    }

    const cancelTransition = assertTransitionAllowed(
      "PURGE_CANCEL",
      org.statusV2 ?? "PURGE_SCHEDULED",
      { hasActiveLegalHold: false },
    );
    if (!cancelTransition.allowed) throw new BadRequestException(cancelTransition.reason);

    const sagaCtx = await this.saga.begin(
      "PURGE_CANCEL",
      orgId,
      `purge-cancel:${orgId}:${actorUserId}`,
      actorUserId,
      org.statusV2,
    );
    const done = new Set(
      sagaCtx.steps.filter((s) => s.state === "DONE").map((s) => s.stepName),
    );

    try {
      if (!done.has("set-status-active"))
        await this.saga.runStep(
          sagaCtx.saga.sagaId,
          "set-status-active",
          () =>
            runInTenantTransaction(
              this.db,
              (tx) =>
                tx
                  .update(organizations)
                  .set({
                    statusV2: "ACTIVE",
                    purgeScheduledAt: null,
                    purgeScheduledBy: null,
                    purgeReason: null,
                    purgeJobId: null,
                  })
                  .where(eq(organizations.id, orgId)),
              { orgId },
            ),
        );

      await this.saga.complete(sagaCtx.saga.sagaId);
    } catch (err) {
      await this.saga.compensate(sagaCtx.saga.sagaId, {});
      throw err;
    }

    this.audit.log({
      action: "org.purge_cancelled",
      userId: actorUserId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });

    return { success: true };
  }
}
