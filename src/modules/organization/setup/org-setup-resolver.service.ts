import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  organizations,
  organizationMembers,
  subscriptions,
} from "../../../db/schema";
import { addDays } from "date-fns";
import { type Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { SetupInput } from "./dto/org.schemas";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { bustMembershipStatusCache } from "../../../common/auth/membership-state.service";
import { randomUUID } from "node:crypto";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";
import {
  runInNewTenantTransaction,
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import { withIdentity } from "../../../common/tenant/with-identity";
import { logger } from "../../../common/logger/logger.service";
import { provisionEmployeeSelfService } from "../../../common/org/provision-employee-self-service";
import {
  getTrialDays,
  TRIAL_PLAN,
} from "../../billing/core/plan-entitlements.constants";
import { placeOrganization } from "../../../common/region/placement-lookup";
import { chooseRegionForNewOrg } from "../../../common/region/cell-admission";

export type SetupMembership = {
  id: number;
  orgId: string;
  existingOrgId: string | null;
  orgName: string | null;
  orgStatus: string | null;
  orgDeletedAt: Date | null;
  status: "INVITED" | "ACTIVE" | "SUSPENDED" | "LEFT";
  isOwner: boolean;
};

export type SetupTarget = {
  orgId: string;
  isOwner: boolean;
};

@Injectable()
export class OrgSetupResolverService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  slugify(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .substring(0, 50) +
      "-" +
      Date.now().toString(36)
    );
  }

  async listSetupMemberships(userId: string): Promise<SetupMembership[]> {
    return withIdentity(this.db, userId, (tx) =>
      tx
        .select({
          id: organizationMembers.id,
          orgId: organizationMembers.orgId,
          existingOrgId: organizations.id,
          orgName: organizations.name,
          orgStatus: organizations.status,
          orgDeletedAt: organizations.deletedAt,
          status: organizationMembers.status,
          isOwner: organizationMembers.isOwner,
        })
        .from(organizationMembers)
        .leftJoin(
          organizations,
          eq(organizations.id, organizationMembers.orgId),
        )
        .where(eq(organizationMembers.userId, userId))
        .orderBy(desc(organizationMembers.joinedAt)),
    );
  }

  suspendedAccessError(organizationName: string | null): ForbiddenException {
    const displayName = organizationName?.trim() || "this organization";
    return new ForbiddenException({
      code: "ORG_MEMBERSHIP_SUSPENDED",
      message: `Your access to ${displayName} is suspended. Ask an organization admin to restore it.`,
      details: { organizationName },
    });
  }

  async resolveCurrentSetupTarget(
    u: CurrentUserContext,
  ): Promise<SetupTarget | null> {
    if (!u.orgId) return null;

    const [membership, organization] = await Promise.all([
      this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, u.userId),
          eq(organizationMembers.orgId, u.orgId),
        ),
        columns: { status: true, isOwner: true },
      }),
      this.db.query.organizations.findFirst({
        where: and(
          eq(organizations.id, u.orgId),
          eq(organizations.status, "ACTIVE"),
          isNull(organizations.deletedAt),
        ),
        columns: { id: true, name: true },
      }),
    ]);

    if (!organization || !membership) return null;
    if (membership.status === "ACTIVE") {
      return { orgId: organization.id, isOwner: membership.isOwner };
    }
    if (membership.status === "SUSPENDED") {
      throw this.suspendedAccessError(organization.name);
    }
    return null;
  }

  resolveExistingSetupTarget(
    u: CurrentUserContext,
    memberships: SetupMembership[],
  ): SetupTarget | null {
    const isAvailable = (membership: SetupMembership) =>
      membership.existingOrgId !== null &&
      membership.orgStatus === "ACTIVE" &&
      membership.orgDeletedAt === null;

    const active =
      memberships.find(
        (membership) =>
          membership.orgId === u.orgId &&
          membership.status === "ACTIVE" &&
          isAvailable(membership),
      ) ??
      memberships.find(
        (membership) =>
          membership.status === "ACTIVE" && isAvailable(membership),
      );

    if (active) {
      return { orgId: active.orgId, isOwner: active.isOwner };
    }

    const suspended =
      memberships.find(
        (membership) =>
          membership.orgId === u.orgId &&
          membership.status === "SUSPENDED" &&
          isAvailable(membership),
      ) ??
      memberships.find(
        (membership) =>
          membership.status === "SUSPENDED" && isAvailable(membership),
      );

    if (suspended) {
      throw this.suspendedAccessError(suspended.orgName);
    }

    return null;
  }

  async resolveOrCreateOrg(
    u: CurrentUserContext,
    input: Pick<SetupInput, "companyName">,
  ): Promise<SetupTarget> {
    const currentTarget = await this.resolveCurrentSetupTarget(u);
    if (currentTarget) return currentTarget;

    const memberships = await this.listSetupMemberships(u.userId);
    const existingTarget = this.resolveExistingSetupTarget(u, memberships);
    if (existingTarget) return existingTarget;

    const orphansByOrg = new Map<string, number[]>();
    for (const m of memberships) {
      if (m.existingOrgId !== null) continue;
      orphansByOrg.set(m.orgId, [...(orphansByOrg.get(m.orgId) ?? []), m.id]);
    }
    for (const [orphanOrgId, ids] of orphansByOrg) {
      try {
        await runInTenantTransaction(
          this.db,
          async (tx) => {
            await tx
              .delete(organizationMembers)
              .where(inArray(organizationMembers.id, ids));
          },
          { orgId: orphanOrgId },
        );
        await bustMembershipStatusCache(this.cache, u.userId, orphanOrgId);
      } catch (error) {
        logger.warn("Orphan membership cleanup failed", {
          userId: u.userId,
          orphanOrgId,
          error,
        });
      }
    }

    const orgId = randomUUID();
    const orgName = input.companyName?.trim() || "My Organization";
    const region = (await chooseRegionForNewOrg(this.db, { organizationId: orgId })).region;
    await placeOrganization(this.db, { orgId, region });

    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const seqRows = await tx.execute(
        sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
      );
      const ownerMembershipId = Number(seqRows[0]?.id);
      if (!Number.isInteger(ownerMembershipId)) {
        throw new Error("Failed to allocate owner membership id");
      }
      await tx.insert(organizations).values({
        id: orgId,
        region,
        name: orgName,
        slug: this.slugify(orgName),
        ownerMembershipId,
      });
      await tx.insert(organizationMembers).values({
        id: ownerMembershipId,
        orgId,
        userId: u.userId,
        role: ORG_MEMBER_ROLES.OWNER,
        isOwner: true,
      });
      const trialDays = getTrialDays();
      await tx.insert(subscriptions).values({
        orgId,
        plan: TRIAL_PLAN,
        status: "TRIAL",
        trialEndsAt: addDays(new Date(), trialDays),
        currentPeriodStart: new Date(),
        currentPeriodEnd: addDays(new Date(), trialDays),
      });
      await provisionEmployeeSelfService(tx, orgId);
      await bumpPermissionsVersion(tx, orgId);
    });

    this.audit.log({
      action: "org.created",
      userId: u.userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });
    return { orgId, isOwner: true };
  }
}
