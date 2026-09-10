import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { organizations, organizationMembers } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { SetupInput } from "./dto/org.schemas";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { withMembershipMutations } from "../../../common/org/membership-mutations";
import { randomUUID } from "node:crypto";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { withIdentity } from "../../../common/tenant/with-identity";
import { logger } from "../../../common/logger/logger.service";
import {
  bootstrapCellOrganization,
  generateOrgSlug,
} from "../core/bootstrap-cell-organization";
import {
  placeOrganization,
  unplaceOrganization,
} from "../../../common/region/placement-lookup";
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
        .orderBy(desc(organizationMembers.joinedAt))
        .limit(100),
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
        await withMembershipMutations(this.cache, (membership) =>
          runInTenantTransaction(
            this.db,
            async (tx) => {
              await membership.deleteMembershipsById(tx, { orgId: orphanOrgId, userId: u.userId, membershipIds: ids });
            },
            { orgId: orphanOrgId },
          ),
        );
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

    // A placed organisation with no rows 401s every request, so placement must be compensated.
    try {
      await bootstrapCellOrganization(this.db, this.cache, {
        orgId,
        userId: u.userId,
        region,
        name: orgName,
        slug: generateOrgSlug(orgName),
        // The wizard chooses the modules; seeding a default set here would enable three the
        // owner never picked and hand them ownership rows for modules they then switched off.
        moduleKeys: [],
      });
    } catch (error) {
      await unplaceOrganization(this.db, orgId).catch((compensationError: unknown) => {
        logger.error("Placement compensation failed after org bootstrap error", {
          userId: u.userId,
          orgId,
          error: compensationError,
        });
      });
      throw error;
    }

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
