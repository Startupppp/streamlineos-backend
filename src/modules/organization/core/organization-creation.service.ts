import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { organizationMembers } from "../../../db/schema";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  chooseRegionForNewOrg,
  regionPlacementCoordinates,
} from "../../../common/region/cell-admission";
import {
  placeOrganization,
  placedOrganizationCoordinates,
  unplaceOrganization,
} from "../../../common/region/placement-lookup";
import {
  bootstrapCellOrganization,
  generateOrgSlug,
} from "./bootstrap-cell-organization";
import { AccountOrganizationIndexService } from "./account-organization-index.service";
import {
  OrganizationSagaBusyError,
  OrganizationSagaService,
} from "./lifecycle/organization-saga.service";
import {
  loadActiveOrganization,
  organizationRowExists,
  setupOrganizationIsReusable,
  type OrganizationIdentity,
} from "./cell-organization-state";

export type CreatedOrganization = OrganizationIdentity;

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
    const requestKey = await this.resolveProfileRequestKey(
      `create:${input.userId}:${input.slug}`,
    );
    return this.create({
      ...input,
      requestKey,
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
    if (saga.state === "COMPLETED") {
      const placement = await placedOrganizationCoordinates(this.db, orgId);
      if (!placement)
        throw new Error(
          `Cannot load completed organization ${orgId} without its placement`,
        );
      const organization = await loadActiveOrganization(
        this.db,
        orgId,
        placement.region,
      );
      if (!organization)
        throw new Error(`Completed organization ${orgId} is no longer active`);
      await this.cache.invalidate(CACHE_KEYS.userSession(input.userId));
      return organization;
    }
    if (saga.state === "COMPENSATED")
      throw new OrganizationSagaBusyError(
        `Organization creation ${input.requestKey} was compensated`,
      );
    const executionToken = await this.saga.claimExecution(saga.sagaId);
    if (!executionToken)
      throw new OrganizationSagaBusyError(
        `Organization creation ${input.requestKey} is already running`,
      );
    const done = new Set(
      steps.filter((step) => step.state === "DONE").map((step) => step.stepName),
    );
    let slug =
      input.slug ??
      generateOrgSlug("organization", orgId.replaceAll("-", ""));
    let region: string | null = null;
    let createdOrganization: CreatedOrganization | null = null;
    let bootstrapAttempted = steps.some(
      (step) =>
        step.stepName === "bootstrap-cell-organization" &&
        step.state !== "PENDING" &&
        step.state !== "COMPENSATED",
    );
    try {
      const [reservedOrgId, reservedSlug] = await Promise.all([
        this.saga.findReservationValue("ORGANIZATION_ID", saga.sagaId),
        this.saga.findReservationValue("SLUG", saga.sagaId),
      ]);
      if (reservedSlug) slug = reservedSlug;

      const placed = await placedOrganizationCoordinates(this.db, orgId);
      if (bootstrapAttempted && placed === null)
        throw new Error(
          `Organization ${orgId} lost its placement after bootstrap began`,
        );
      const selectedPlacement =
        placed ??
        regionPlacementCoordinates(
          await chooseRegionForNewOrg(this.db, { organizationId: orgId }),
        );
      region = selectedPlacement.region;

      if (
        !done.has("reserve-identity") ||
        reservedOrgId !== orgId ||
        reservedSlug !== slug
      )
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
            await this.saga.release("ORGANIZATION_ID", orgId, saga.sagaId);
            throw error;
          }
        }, executionToken);

      if (!done.has("reserve-placement") || placed === null)
        await this.saga.runStep(saga.sagaId, "reserve-placement", () =>
          placeOrganization(this.db, { orgId, ...selectedPlacement }),
        executionToken);

      const authoritativePlacement = await placedOrganizationCoordinates(
        this.db,
        orgId,
      );
      if (authoritativePlacement === null)
        throw new Error(`Organization ${orgId} has no placement after reservation`);
      region = authoritativePlacement.region;
      const bootstrapRegion = region;

      if (!done.has("bootstrap-cell-organization")) {
        bootstrapAttempted = true;
        await this.saga.runStep(
          saga.sagaId,
          "bootstrap-cell-organization",
          () =>
            bootstrapCellOrganization(this.db, this.cache, {
              orgId,
              userId: input.userId,
              region: bootstrapRegion,
              name: input.name,
              slug,
              billingEmail: input.billingEmail,
              onboardingCompletedAt: input.onboardingCompletedAt,
              ownerActivatedAt: input.ownerActivatedAt,
              moduleKeys: input.moduleKeys,
            }),
          executionToken,
        );
      }

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
          executionToken,
        );

      if (!done.has("activate-directory-projection"))
        await this.saga.runStep(
          saga.sagaId,
          "activate-directory-projection",
          async () => {
            await this.indexService.refreshForUser(input.userId);
            await this.indexService.touchLastActivated(input.userId, orgId);
          },
          executionToken,
        );

      createdOrganization = await loadActiveOrganization(
        this.db,
        orgId,
        bootstrapRegion,
      );
      if (!createdOrganization)
        throw new Error(`Organization ${orgId} is missing after creation completed`);
      await this.saga.claim("ORGANIZATION_ID", orgId, saga.sagaId);
      await this.saga.claim("SLUG", slug, saga.sagaId);
      await this.saga.complete(saga.sagaId, executionToken);
    } catch (error) {
      const ownsExecution = await this.saga
        .ownsExecution(saga.sagaId, executionToken)
        .catch(() => false);
      if (!ownsExecution) throw error;
      const bootstrapExists = bootstrapAttempted
        ? region === null
          ? true
          : await organizationRowExists(this.db, orgId, region).catch(() => true)
        : false;
      if (!bootstrapExists) {
        await unplaceOrganization(this.db, orgId);
        await this.saga.release("SLUG", slug, saga.sagaId);
        await this.saga.release("ORGANIZATION_ID", orgId, saga.sagaId);
        await this.saga.markCompensated(saga.sagaId, executionToken);
      } else await this.saga.markFailed(saga.sagaId, error, executionToken);
      throw error;
    }

    await this.cache.invalidate(CACHE_KEYS.userSession(input.userId));
    return createdOrganization;
  }

  private async resolveProfileRequestKey(base: string): Promise<string> {
    let requestKey = base;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const existing = await this.saga.findByRequestKey(requestKey);
      if (!existing || existing.state !== "COMPENSATED") return requestKey;
      requestKey = `${base}:after:${existing.sagaId}`;
    }

    throw new Error("Too many compensated organization creation attempts");
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
    const placement = await placedOrganizationCoordinates(this.db, orgId);
    if (placement === null) {
      if (await this.saga.wasTerminallyDeleted(orgId)) return false;
      throw new Error(
        `Cannot verify completed setup organization ${orgId} without its placement`,
      );
    }

    return setupOrganizationIsReusable(
      this.db,
      orgId,
      placement.region,
      userId,
    );
  }
}
