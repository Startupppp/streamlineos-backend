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
import { placedOrganizationCoordinates } from "../../../common/region/placement-lookup";
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

export type OrganizationAbsenceVerdict =
  | { status: "absent" }
  | { status: "placed"; region: string; cellId: string }
  | { status: "unverified"; reason: string };

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

  async verifyOrganizationAbsence(
    orgId: string,
  ): Promise<OrganizationAbsenceVerdict> {
    try {
      const placement = await placedOrganizationCoordinates(this.db, orgId);
      if (placement)
        return {
          status: "placed",
          region: placement.region,
          cellId: placement.cellId,
        };
      return { status: "absent" };
    } catch (error) {
      return {
        status: "unverified",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async cleanUpProvablyAbsentMemberships(
    userId: string,
    memberships: readonly SetupMembership[],
  ): Promise<void> {
    const unresolvedByOrg = new Map<string, number[]>();
    for (const m of memberships) {
      if (m.existingOrgId !== null) continue;
      unresolvedByOrg.set(m.orgId, [...(unresolvedByOrg.get(m.orgId) ?? []), m.id]);
    }

    for (const [candidateOrgId, membershipIds] of unresolvedByOrg) {
      const verdict = await this.verifyOrganizationAbsence(candidateOrgId);
      if (verdict.status !== "absent") {
        logger.warn("Retaining membership rows: organization absence is not proven", {
          userId,
          candidateOrgId,
          verdict: verdict.status,
          ...(verdict.status === "placed"
            ? { region: verdict.region, cellId: verdict.cellId }
            : { reason: verdict.reason }),
        });
        continue;
      }

      try {
        await withMembershipMutations(this.cache, (membership) =>
          runInTenantTransaction(
            this.db,
            async (tx) => {
              await membership.deleteMembershipsById(tx, {
                orgId: candidateOrgId,
                userId,
                membershipIds,
              });
            },
            { orgId: candidateOrgId },
          ),
        );
      } catch (error) {
        logger.warn("Absent-organization membership cleanup failed", {
          userId,
          candidateOrgId,
          error,
        });
      }
    }
  }

  private async findActiveSetupTarget(userId: string): Promise<SetupTarget | null> {
    const rows = await withIdentity(this.db, userId, (tx) =>
      tx
        .select({ orgId: organizationMembers.orgId, isOwner: organizationMembers.isOwner })
        .from(organizationMembers)
        .innerJoin(
          organizations,
          and(
            eq(organizations.id, organizationMembers.orgId),
            eq(organizations.status, "ACTIVE"),
            isNull(organizations.deletedAt),
          ),
        )
        .where(
          and(
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .orderBy(desc(organizationMembers.joinedAt))
        .limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    return { orgId: row.orgId, isOwner: row.isOwner };
  }

  async resolveOrCreateOrg(
    u: CurrentUserContext,
    input: Pick<SetupInput, "companyName">,
  ): Promise<SetupTarget> {
    const currentTarget = await this.resolveCurrentSetupTarget(u);
    if (currentTarget) return currentTarget;

    const activeTarget = await this.findActiveSetupTarget(u.userId);
    if (activeTarget) return activeTarget;

    const memberships = await this.listSetupMemberships(u.userId);
    const existingTarget = this.resolveExistingSetupTarget(u, memberships);
    if (existingTarget) return existingTarget;

    await this.cleanUpProvablyAbsentMemberships(u.userId, memberships);

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
