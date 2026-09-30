import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { organizationMembers, organizations, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import type { CreateOrganizationInput } from "./dto/organization.schemas";
import { withIdentity } from "../../../common/tenant/with-identity";
import {
  getRegionRegistry,
  hasRegionRegistry,
  PlacementRefusedError,
} from "../../../common/region/region-registry";
import { logger } from "../../../common/logger/logger.service";
import { AccountOrganizationIndexService } from "./account-organization-index.service";
import { OrganizationCreationService } from "./organization-creation.service";

@Injectable()
export class OrgProfileService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly indexService: AccountOrganizationIndexService,
    private readonly creation: OrganizationCreationService,
  ) {}

  async listUserOrganizations(userId: string) {
    const fromIndex = await this.indexService.listForUser(userId);
    if (fromIndex.length > 0) return fromIndex;

    void this.indexService.refreshForUser(userId).catch((error: unknown) => {
      logger.error("[account-org-index] cold-path projection failed", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    const memberships = await withIdentity(this.db, userId, (tx) =>
      tx
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          role: organizationMembers.role,
          joinedAt: organizationMembers.joinedAt,
        })
        .from(organizationMembers)
        .innerJoin(
          organizations,
          eq(organizations.id, organizationMembers.orgId),
        )
        .where(
          and(
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.status, "ACTIVE"),
            eq(organizations.status, "ACTIVE"),
            isNull(organizations.deletedAt),
          ),
        )
        .orderBy(desc(organizationMembers.joinedAt))
        .limit(100),
    );

    return memberships.map((m) => ({
      id: m.id,
      name: m.name,
      slug: m.slug,
      role: m.role,
      joinedAt: m.joinedAt,
    }));
  }

  async switchOrg(userId: string, targetOrgId: string) {
    let targetDb: Db = this.db;
    if (hasRegionRegistry()) {
      try {
        const placement = await getRegionRegistry().admittedPlacementForOrg(targetOrgId, "write");
        targetDb = getRegionRegistry().bindingFor(placement.region).db;
      } catch (err) {
        if (err instanceof PlacementRefusedError) throw err;
        throw new NotFoundException("Organization not found");
      }
    }

    const { outgoingOrgId, ...switchResult } = await withIdentity(targetDb, userId, async (tx) => {
      const membership = await tx.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.orgId, targetOrgId),
        ),
        columns: { role: true, status: true },
      });
      if (!membership)
        throw new BadRequestException(
          "You are not a member of this organization",
        );

      if (membership.status === "SUSPENDED")
        throw new ConflictException(
          "Your membership in this organization is suspended. Ask an admin to restore access.",
        );

      if (membership.status === "LEFT")
        throw new ForbiddenException(
          "You are no longer a member of this organization",
        );

      if (membership.status !== "ACTIVE")
        throw new ForbiddenException(
          "You are not an active member of this organization",
        );

      const [org] = await tx
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

      const [currentUser] = await tx
        .select({ lastActiveOrgId: users.lastActiveOrgId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const outgoingOrgId = currentUser?.lastActiveOrgId ?? null;

      await tx
        .update(users)
        .set({ lastActiveOrgId: targetOrgId })
        .where(eq(users.id, userId));

      return {
        outgoingOrgId,
        orgId: org.id,
        name: org.name,
        slug: org.slug,
        role: membership.role,
      };
    });

    // The session resolves its org from `last_activated_at`, so the stamp must land BEFORE the
    // cache is dropped — an `update()` racing an unawaited write re-cached the outgoing org.
    await this.indexService.activate(userId, targetOrgId);
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
    if (outgoingOrgId && outgoingOrgId !== targetOrgId) {
      await this.cache.invalidate(CACHE_KEYS.accessVersion(outgoingOrgId));
    }

    this.audit.log({
      action: "org.switched",
      userId,
      orgId: targetOrgId,
      targetType: "organization",
      targetId: targetOrgId,
    });
    void this.indexService
      .refreshForUser(userId)
      .catch((error: unknown) => {
        logger.error("[account-org-index] opportunistic refresh failed", {
          userId,
          targetOrgId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return switchResult;
  }

  async createOrganization(userId: string, input: CreateOrganizationInput) {
    let billingEmail: string | null = input.billingEmail ?? null;
    if (!billingEmail) {
      const [actor] = await this.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      billingEmail = actor?.email ?? null;
    }
    return this.creation.createFromProfile({
      userId,
      name: input.name,
      slug: input.slug,
      billingEmail,
      country: input.country ?? null,
      timezone: input.timezone ?? null,
    });
  }

  async getProfile(userId: string, orgId: string) {
    return this.cache.cachedVersionedForOrg(
      orgId,
      "org:profile",
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
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) return null;

    const [organization] = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        logo: organizations.logo,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

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
      )
      .limit(1);

    return {
      user,
      organization: organization ?? null,
      membership: membership ?? null,
    };
  }
}
