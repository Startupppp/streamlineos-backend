import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { organizationMembers, organizations } from "../../../db/schema";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { chooseRegionForNewOrg } from "../../../common/region/cell-admission";
import {
  placeOrganization,
  placedOrganizationRegion,
  unplaceOrganization,
} from "../../../common/region/placement-lookup";
import {
  getRegionRegistry,
  hasRegionRegistry,
} from "../../../common/region/region-registry";
import {
  bootstrapCellOrganization,
  generateOrgSlug,
} from "./bootstrap-cell-organization";
import { AccountOrganizationIndexService } from "./account-organization-index.service";
import { OrganizationSagaService } from "./lifecycle/organization-saga.service";

export interface CreatedOrganization {
  id: string;
  name: string;
  slug: string;
}

interface OrganizationCreationInput {
  requestKey: string;
  userId: string;
  name: string;
  slug?: string;
  billingEmail: string | null;
  onboardingCompletedAt: Date | null;
  ownerActivatedAt: Date | null;
  moduleKeys?: readonly string[];
}

@Injectable()
export class OrganizationCreationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly indexService: AccountOrganizationIndexService,
    private readonly saga: OrganizationSagaService,
  ) {}

  async createFromProfile(input: {
    userId: string;
    name: string;
    slug: string;
    billingEmail: string | null;
  }): Promise<CreatedOrganization> {
    const activatedAt = new Date();
    return this.create({
      ...input,
      requestKey: `create:${input.userId}:${input.slug}`,
      onboardingCompletedAt: activatedAt,
      ownerActivatedAt: activatedAt,
    });
  }

  async createFromSetup(input: {
    userId: string;
    name: string;
  }): Promise<CreatedOrganization> {
    const requestKey = await this.resolveSetupRequestKey(input.userId);
    return this.create({
      ...input,
      requestKey,
      billingEmail: null,
      onboardingCompletedAt: null,
      ownerActivatedAt: null,
      moduleKeys: [],
    });
  }

  private async create(input: OrganizationCreationInput): Promise<CreatedOrganization> {
    const { saga, steps } = await this.saga.begin(
      "CREATE",
      randomUUID(),
      input.requestKey,
      input.userId,
      null,
    );
    const orgId = saga.organizationId;
    const slug = input.slug ?? generateOrgSlug(input.name, orgId.replaceAll("-", ""));
    const done = new Set(
      steps.filter((step) => step.state === "DONE").map((step) => step.stepName),
    );
    try {
      const placedRegion = await placedOrganizationRegion(this.db, orgId);
      if (done.has("reserve-placement") && placedRegion === null)
        throw new Error(
          `Organization ${orgId} has no placement for its resumed creation saga`,
        );
      const region =
        placedRegion ??
        (await chooseRegionForNewOrg(this.db, { organizationId: orgId })).region;

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
              slug,
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
              userId: input.userId,
              region,
              name: input.name,
              slug,
              billingEmail: input.billingEmail,
              onboardingCompletedAt: input.onboardingCompletedAt,
              ownerActivatedAt: input.ownerActivatedAt,
              moduleKeys: input.moduleKeys,
            }),
        );

      if (!done.has("bootstrap-owner-membership"))
        await this.saga.runStep(
          saga.sagaId,
          "bootstrap-owner-membership",
          async () => {
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
          },
        );

      if (!done.has("activate-directory-projection"))
        await this.saga.runStep(
          saga.sagaId,
          "activate-directory-projection",
          async () => {
            await this.indexService.refreshForUser(input.userId);
            await this.indexService.touchLastActivated(input.userId, orgId);
          },
        );

      await this.saga.complete(saga.sagaId);
      await this.saga.claim("ORGANIZATION_ID", orgId);
      await this.saga.claim("SLUG", slug);
    } catch (error) {
      await this.saga.compensate(saga.sagaId, {
        "reserve-identity": async () => {
          await this.saga.release("SLUG", slug);
          await this.saga.release("ORGANIZATION_ID", orgId);
        },
        "reserve-placement": () => unplaceOrganization(this.db, orgId),
      });
      throw error;
    }

    await this.cache.invalidate(CACHE_KEYS.userSession(input.userId));
    return { id: orgId, name: input.name, slug };
  }

  private async resolveSetupRequestKey(userId: string): Promise<string> {
    const base = `setup-create:${userId}`;
    let requestKey = base;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const existing = await this.saga.findByRequestKey(requestKey);
      if (!existing) return requestKey;
      if (existing.state !== "COMPLETED" && existing.state !== "COMPENSATED")
        return requestKey;
      if (
        existing.state === "COMPLETED" &&
        (await this.isReusableSetupOrganization(existing.organizationId, userId))
      )
        return requestKey;
      requestKey = `${base}:after:${existing.sagaId}`;
    }

    throw new Error(`Too many completed setup creation attempts for user ${userId}`);
  }

  private async isReusableSetupOrganization(
    orgId: string,
    userId: string,
  ): Promise<boolean> {
    const region = await placedOrganizationRegion(this.db, orgId);
    if (region === null) return false;

    let targetDb = this.db;
    if (hasRegionRegistry()) {
      try {
        targetDb = getRegionRegistry().bindingFor(region).db;
      } catch {
        return false;
      }
    }

    return runInNewTenantTransaction(targetDb, orgId, async (tx) => {
      const [organization, membership] = await Promise.all([
        tx.query.organizations.findFirst({
          where: and(
            eq(organizations.id, orgId),
            eq(organizations.status, "ACTIVE"),
            isNull(organizations.deletedAt),
          ),
          columns: { id: true },
        }),
        tx.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.status, "ACTIVE"),
            eq(organizationMembers.isOwner, true),
          ),
          columns: { id: true },
        }),
      ]);
      return organization != null && membership != null;
    });
  }
}
