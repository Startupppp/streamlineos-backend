import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { organizationMembers, organizations, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import type { CreateOrganizationInput } from "./dto/organization.schemas";
import { bootstrapCellOrganization } from "./bootstrap-cell-organization";
import { withIdentity } from "../../../common/tenant/with-identity";
import {
  getRegionRegistry,
  hasRegionRegistry,
  PlacementRefusedError,
} from "../../../common/region/region-registry";
import {
  placeOrganization,
  unplaceOrganization,
} from "../../../common/region/placement-lookup";
import { chooseRegionForNewOrg } from "../../../common/region/cell-admission";
import { logger } from "../../../common/logger/logger.service";
import { AccountOrganizationIndexService } from "./account-organization-index.service";
import { OrganizationSagaService } from "./lifecycle/organization-saga.service";

@Injectable()
export class OrgProfileService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly indexService: AccountOrganizationIndexService,
    private readonly saga: OrganizationSagaService,
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

    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
    if (outgoingOrgId && outgoingOrgId !== targetOrgId) {
      await this.cache.invalidate(CACHE_KEYS.accessVersion(outgoingOrgId));
    }

    this.audit.log({ action: "org.switched", userId, orgId: targetOrgId });
    void this.indexService
      .refreshForUser(userId)
      .then(() => this.indexService.touchLastActivated(userId, targetOrgId))
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
    const requestKey = `create:${userId}:${input.slug}`;
    const { saga, steps } = await this.saga.begin(
      "CREATE",
      randomUUID(),
      requestKey,
      userId,
      null,
    );

    const orgId = saga.organizationId;
    const done = new Set(
      steps.filter((step) => step.state === "DONE").map((step) => step.stepName),
    );
    const region = (await chooseRegionForNewOrg(this.db, { organizationId: orgId })).region;

    try {
      if (!done.has("reserve-identity"))
        await this.saga.runStep(saga.sagaId, "reserve-identity", async () => {
          const idReserved = await this.saga.reserve(
            "ORGANIZATION_ID",
            orgId,
            orgId,
            saga.sagaId,
          );
          if (!idReserved)
            throw new ConflictException("Organization id is already reserved");

          try {
            const slugReserved = await this.saga.reserve(
              "SLUG",
              input.slug,
              orgId,
              saga.sagaId,
            );
            if (!slugReserved)
              throw new ConflictException("Organization slug already exists");
          } catch (error) {
            await this.saga.release("ORGANIZATION_ID", orgId);
            throw error;
          }
        });

      if (!done.has("reserve-placement"))
        await this.saga.runStep(saga.sagaId, "reserve-placement", () =>
          placeOrganization(this.db, { orgId, region }),
        );

      if (!done.has("bootstrap-cell-organization"))
        await this.saga.runStep(
          saga.sagaId,
          "bootstrap-cell-organization",
          () =>
            bootstrapCellOrganization(this.db, this.cache, {
              orgId,
              userId,
              region,
              name: input.name,
              slug: input.slug,
              billingEmail,
              onboardingCompletedAt: new Date(),
              ownerActivatedAt: new Date(),
            }),
        );

      if (!done.has("bootstrap-owner-membership"))
        await this.saga.runStep(saga.sagaId, "bootstrap-owner-membership", async () => {
          const [owner] = await runInNewTenantTransaction(this.db, orgId, (tx) =>
            tx
              .select({ id: organizationMembers.id })
              .from(organizationMembers)
              .where(
                and(
                  eq(organizationMembers.orgId, orgId),
                  eq(organizationMembers.isOwner, true),
                ),
              )
              .limit(1),
          );
          if (!owner)
            throw new Error(
              `Organization ${orgId} was created without an owner membership`,
            );
        });

      if (!done.has("activate-directory-projection"))
        await this.saga.runStep(saga.sagaId, "activate-directory-projection", async () => {
          await this.indexService.refreshForUser(userId);
          await this.indexService.touchLastActivated(userId, orgId);
        });

      await this.saga.complete(saga.sagaId);
      await this.saga.claim("ORGANIZATION_ID", orgId);
      await this.saga.claim("SLUG", input.slug);
    } catch (error) {
      await this.saga.compensate(saga.sagaId, {
        "reserve-identity": async () => {
          await this.saga.release("SLUG", input.slug);
          await this.saga.release("ORGANIZATION_ID", orgId);
        },
        "reserve-placement": () => unplaceOrganization(this.db, orgId),
      });
      throw error;
    }

    await this.cache.invalidate(CACHE_KEYS.userSession(userId));

    return { id: orgId, name: input.name, slug: input.slug };
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
