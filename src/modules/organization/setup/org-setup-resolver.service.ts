import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { organizations, organizationMembers } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { SetupInput } from "./dto/org.schemas";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { withMembershipMutations } from "../../../common/org/membership-mutations";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { withIdentity } from "../../../common/tenant/with-identity";
import { logger } from "../../../common/logger/logger.service";
import { OrganizationCreationService } from "../core/organization-creation.service";

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
    private readonly creation: OrganizationCreationService,
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

    // The setup routes carry `@NoTenantTransaction()`, so only `withIdentity` sets a GUC the
    // `organization_members` policy admits on; without it this read silently matched nothing.
    const [membership, organization] = await withIdentity(this.db, u.userId, (tx) =>
      Promise.all([
        tx.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.userId, u.userId),
            eq(organizationMembers.orgId, u.orgId),
          ),
          columns: { status: true, isOwner: true },
        }),
        tx.query.organizations.findFirst({
          where: and(
            eq(organizations.id, u.orgId),
            eq(organizations.status, "ACTIVE"),
            isNull(organizations.deletedAt),
          ),
          columns: { id: true, name: true },
        }),
      ]),
    );

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

    const orgName = input.companyName?.trim() || "My Organization";
    const organization = await this.creation.createFromSetup({
      userId: u.userId,
      name: orgName,
    });

    this.audit.log({
      action: "org.created",
      userId: u.userId,
      orgId: organization.id,
      targetId: organization.id,
      targetType: "organization",
    });
    return { orgId: organization.id, isOwner: true };
  }
}
