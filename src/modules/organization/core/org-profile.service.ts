import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { organizationMembers, organizations, subscriptions, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { seedSystemRolesForOrg } from "../../rbac/seed-system-roles";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import type { CreateOrganizationInput } from "./dto/organization.schemas";
import { addDays } from "date-fns";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";
import { getTrialDays, TRIAL_PLAN } from "../../billing/core/plan-entitlements.constants";
import {
  provisionOrgModules,
  DEFAULT_SKIP_MODULES,
} from "../../../common/org/provision-org-modules";
import { provisionEmployeeSelfService } from "../../../common/org/provision-employee-self-service";

@Injectable()
export class OrgProfileService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async listUserOrganizations(userId: string) {
    const memberships = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(
        and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "ACTIVE"),
          eq(organizations.status, "ACTIVE"),
          isNull(organizations.deletedAt),
        ),
      )
      .orderBy(desc(organizationMembers.joinedAt));

    return memberships.map((m) => ({
      id: m.id,
      name: m.name,
      slug: m.slug,
      role: m.role,
      joinedAt: m.joinedAt,
    }));
  }

  async switchOrg(userId: string, targetOrgId: string) {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, targetOrgId),
      ),
      columns: { role: true, status: true },
    });
    if (!membership) {
      throw new BadRequestException(
        "You are not a member of this organization",
      );
    }
    if (membership.status === "SUSPENDED") {
      throw new ConflictException(
        "Your membership in this organization is suspended. Ask an admin to restore access.",
      );
    }
    if (membership.status === "LEFT") {
      throw new ForbiddenException(
        "You are no longer a member of this organization",
      );
    }
    if (membership.status !== "ACTIVE") {
      throw new ForbiddenException(
        "You are not an active member of this organization",
      );
    }

    const [org] = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        status: organizations.status,
        deletedAt: organizations.deletedAt,
      })
      .from(organizations)
      .where(eq(organizations.id, targetOrgId))
      .limit(1);
    if (!org) throw new BadRequestException("Organization not found");
    if (org.status !== "ACTIVE" || org.deletedAt !== null) {
      throw new ConflictException(
        "This organization is archived or unavailable. Restore it before switching to it.",
      );
    }

    await this.db
      .update(users)
      .set({ lastActiveOrgId: targetOrgId })
      .where(eq(users.id, userId));

    await this.cache.invalidate(CACHE_KEYS.userSession(userId));

    this.audit.log({ action: "org.switched", userId, orgId: targetOrgId });

    return {
      orgId: org.id,
      name: org.name,
      slug: org.slug,
      role: membership.role,
    };
  }

  async createOrganization(userId: string, input: CreateOrganizationInput) {
    const [existing] = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, input.slug))
      .limit(1);

    if (existing)
      throw new ConflictException("Organization slug already exists");

    const orgId = randomUUID();

    let billingEmail: string | null = input.billingEmail ?? null;
    if (!billingEmail) {
      const [actor] = await this.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      billingEmail = actor?.email ?? null;
    }

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
        name: input.name,
        slug: input.slug,
        billingEmail,
        ownerMembershipId,
        onboardingCompletedAt: new Date(),
      });
      await tx.insert(organizationMembers).values({
        id: ownerMembershipId,
        userId,
        orgId,
        role: "OWNER",
        isOwner: true,
        status: "ACTIVE",
        activatedAt: new Date(),
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
      await seedSystemRolesForOrg(this.db, orgId);
      await provisionOrgModules(tx, orgId, DEFAULT_SKIP_MODULES, userId);
      await tx.update(users).set({ lastActiveOrgId: orgId }).where(eq(users.id, userId));
    });

    await this.cache.invalidate(CACHE_KEYS.userSession(userId));

    return { id: orgId, name: input.name, slug: input.slug };
  }

  async getProfile(userId: string, orgId: string) {
    return this.cache.cachedVersioned(
      CACHE_KEYS.orgProfileNamespace(orgId),
      userId,
      () => this.fetchProfile(userId, orgId),
      120,
    );
  }

  private async fetchProfile(userId: string, orgId: string) {
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
        role: organizationMembers.role,
      })
      .from(users)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.userId, users.id),
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .where(eq(users.id, userId));

    if (!user) return null;

    const [organization] = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        logo: organizations.logo,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));

    const [membership] = await this.db
      .select({
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      );

    return {
      user,
      organization: organization ?? null,
      membership: membership ?? null,
    };
  }
}
