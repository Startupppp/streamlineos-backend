import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  accountOrganizationIndex,
  organizationLegalHolds,
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  assertTransitionAllowed,
} from "./lifecycle/organization-lifecycle-transitions";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { bustMembershipsAfterOrgTeardown } from "../../../common/org/membership-bust";
import { OrgMembershipService } from "./org-membership.service";
import { InvitationLifecycleService } from "./invitation-lifecycle.service";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import {
  runInNewTenantTransaction,
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import { withIdentity } from "../../../common/tenant/with-identity";
import { repairLastActiveOrgIds } from "./lifecycle/last-active-org-repair";
import { nextActiveOrgIdsQuery } from "./lifecycle/next-active-org";
import { OrganizationSagaService } from "./lifecycle/organization-saga.service";

@Injectable()
export class OrgLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly orgMembership: OrgMembershipService,
    private readonly invitations: InvitationLifecycleService,
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
    await bustMembershipsAfterOrgTeardown(this.cache, memberUserIds);
    await this.cache.invalidateMany(memberUserIds.map(CACHE_KEYS.userSession));
  }

  private async revokeMembersAccess(orgId: string, memberUserIds: string[]): Promise<void> {
    for (const memberUserId of memberUserIds) {
      await this.orgMembership.revokeOrgScopedAccess(orgId, memberUserId, "removed");
    }
  }

  private async resolveReplacementOrgIds(
    orgId: string,
    memberUserIds: string[],
  ): Promise<Map<string, string | null>> {
    const replacements = new Map<string, string | null>(
      memberUserIds.map((memberUserId) => [memberUserId, null]),
    );
    if (memberUserIds.length === 0) return replacements;
    const rows = await runInTenantTransaction(
      this.db,
      (tx) => tx.execute(nextActiveOrgIdsQuery(memberUserIds)),
      { orgId },
    );
    for (const row of rows) {
      const memberUserId = typeof row.user_id === "string" ? row.user_id : null;
      if (memberUserId === null) continue;
      replacements.set(
        memberUserId,
        typeof row.next_org_id === "string" ? row.next_org_id : null,
      );
    }
    return replacements;
  }


  async listArchivedOwnedOrganizations(userId: string) {
    const rows = await withIdentity(this.db, userId, (tx) =>
      tx
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
        })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
        .where(
          and(
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.isOwner, true),
            eq(organizationMembers.status, "ACTIVE"),
            eq(organizations.status, "ARCHIVED"),
          ),
        )
        .orderBy(desc(organizationMembers.joinedAt))
        .limit(100),
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
    }));
  }

  async archiveOrg(orgId: string, userId: string) {
    const preflight = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [row] = await tx
          .select({ statusV2: organizations.statusV2 })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1);
        if (!row) return null;

        return {
          statusV2: row.statusV2,
          hasActiveLegalHold: await this.hasActiveLegalHold(orgId, tx),
          memberUserIds: await this.listMemberUserIds(tx, orgId),
        };
      },
      { orgId },
    );
    if (!preflight) throw new NotFoundException("Organization not found");

    const transition = assertTransitionAllowed(
      "ARCHIVE",
      preflight.statusV2 ?? "ACTIVE",
      { hasActiveLegalHold: preflight.hasActiveLegalHold },
    );
    if (!transition.allowed) throw new BadRequestException(transition.reason);

    const memberUserIds = preflight.memberUserIds;
    const replacements = await this.resolveReplacementOrgIds(orgId, memberUserIds);

    const sagaCtx = await this.saga.begin(
      "ARCHIVE",
      orgId,
      `archive:${orgId}:${userId}`,
      userId,
      preflight.statusV2 ?? "ACTIVE",
    );
    const done = new Set(
      sagaCtx.steps.filter((s) => s.state === "DONE").map((s) => s.stepName),
    );

    try {
      if (!done.has("revoke-invitations"))
        await this.saga.runStep(sagaCtx.saga.sagaId, "revoke-invitations", () =>
          runInTenantTransaction(
            this.db,
            (tx) => this.invitations.revokeAllPending(orgId, tx),
            { orgId },
          ),
        );

      if (!done.has("set-status-archived"))
        await this.saga.runStep(sagaCtx.saga.sagaId, "set-status-archived", () =>
          runInTenantTransaction(
            this.db,
            async (tx) => {
              await repairLastActiveOrgIds(tx, orgId, replacements);
              await tx
                .update(organizations)
                .set({ status: "ARCHIVED", deletedAt: new Date() })
                .where(eq(organizations.id, orgId));
              await tx
                .update(accountOrganizationIndex)
                .set({ organizationStatus: "ARCHIVED" })
                .where(eq(accountOrganizationIndex.orgId, orgId));
            },
            { orgId },
          ),
        );

      if (!done.has("revoke-member-access"))
        await this.saga.runStep(sagaCtx.saga.sagaId, "revoke-member-access", async () => {
          await this.revokeMembersAccess(orgId, memberUserIds);
          await this.bustMembersMembership(orgId, memberUserIds);
        });

      await this.saga.complete(sagaCtx.saga.sagaId);
    } catch (err) {
      await this.saga.compensate(sagaCtx.saga.sagaId, {});
      throw err;
    }

    const nextOrgId = replacements.get(userId) ?? null;

    this.audit.log({
      action: "org.archived",
      userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });
    return { success: true as const, nextOrgId };
  }

  async restoreOrg(orgId: string, userId: string) {
    const [row] = await withIdentity(this.db, userId, (tx) =>
      tx
        .select({
          orgStatus: organizations.status,
          statusV2: organizations.statusV2,
          isOwner: organizationMembers.isOwner,
          memberStatus: organizationMembers.status,
        })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
        .where(
          and(
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.orgId, orgId),
          ),
        )
        .limit(1),
    );

    if (!row || !row.isOwner || row.memberStatus !== "ACTIVE") {
      throw new NotFoundException("Organization not found");
    }
    if (row.orgStatus !== "ARCHIVED") {
      throw new BadRequestException("Organization is not archived");
    }
    // `POST /organization/restore` is @NoTenantTransaction(), so this needs its own GUC — the
    // archive path gets one only because it passes the surrounding transaction's `tx`.
    const activeLegalHoldForRestore = await runInNewTenantTransaction(
      this.db,
      orgId,
      (tx) => this.hasActiveLegalHold(orgId, tx),
    );
    const transition = assertTransitionAllowed(
      "RESTORE",
      row.statusV2 ?? "ARCHIVED",
      { hasActiveLegalHold: activeLegalHoldForRestore },
    );
    if (!transition.allowed) throw new BadRequestException(transition.reason);

    const sagaCtx = await this.saga.begin(
      "RESTORE",
      orgId,
      `restore:${orgId}:${userId}`,
      userId,
      row.statusV2 ?? "ARCHIVED",
    );
    const done = new Set(
      sagaCtx.steps.filter((s) => s.state === "DONE").map((s) => s.stepName),
    );

    let memberUserIds: string[] = [];
    try {
      if (!done.has("set-status-active"))
        memberUserIds = await this.saga.runStep(
          sagaCtx.saga.sagaId,
          "set-status-active",
          () =>
            runInTenantTransaction(
              this.db,
              async (tx) => {
                const ids = await this.listMemberUserIds(tx, orgId);
                await tx
                  .update(organizations)
                  .set({ status: "ACTIVE", deletedAt: null })
                  .where(eq(organizations.id, orgId));
                await tx
                  .update(users)
                  .set({ lastActiveOrgId: orgId })
                  .where(eq(users.id, userId));
                return ids;
              },
              { orgId },
            ),
        );

      await this.saga.complete(sagaCtx.saga.sagaId);
    } catch (err) {
      await this.saga.compensate(sagaCtx.saga.sagaId, {});
      throw err;
    }

    // A replay skips the step that collected member ids, and an empty list busts nobody — the
    // restoring owner then reads a 60s-old session with no org and lands back in the wizard.
    if (memberUserIds.length === 0)
      memberUserIds = await runInNewTenantTransaction(this.db, orgId, (tx) =>
        this.listMemberUserIds(tx, orgId),
      );

    await withIdentity(this.db, userId, (tx) =>
      tx
        .update(accountOrganizationIndex)
        .set({ organizationStatus: "ACTIVE", lastActivatedAt: new Date() })
        .where(
          and(
            eq(accountOrganizationIndex.userId, userId),
            eq(accountOrganizationIndex.orgId, orgId),
          ),
        ),
    );
    await this.bustMembersMembership(orgId, memberUserIds);

    this.audit.log({
      action: "org.restored",
      userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });
    return { success: true as const, orgId };
  }

}
