import { ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { addDays } from "date-fns";
import {
  organizationMembers,
  organizations,
  subscriptions,
  users,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import type { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { bumpPermissionsVersion } from "../../../../common/rbac/access-invalidate";
import { seedSystemRolesForOrg } from "../../../rbac/seed-system-roles";
import {
  getTrialDays,
  TRIAL_PLAN,
} from "../../../billing/core/plan-entitlements.constants";
import {
  provisionOrgModules,
  DEFAULT_SKIP_MODULES,
} from "../../../../common/org/provision-org-modules";
import { provisionEmployeeSelfService } from "../../../../common/org/provision-employee-self-service";
import {
  placeOrganization,
  unplaceOrganization,
} from "../../../../common/region/placement-lookup";
import { chooseRegionForNewOrg } from "../../../../common/region/cell-admission";
import type { AccountOrganizationIndexService } from "../account-organization-index.service";
import type { OrganizationSagaService } from "../lifecycle/organization-saga.service";
import type { CreateOrganizationInput } from "../dto/organization.schemas";

/**
 * Creating an organisation, which is the only operation here that has to be
 * resumable.
 *
 * Everything else on OrgProfileService acts on an organisation that already
 * exists — listing a user's memberships, switching the active one, reading a
 * profile — so the worst a crash costs is a retry. Creation cannot be retried
 * blindly: it reserves a globally unique id and slug, places the org in a
 * region, bootstraps the owner membership, the trial subscription, the system
 * roles and the module provisioning, and then activates the directory
 * projection. A crash halfway leaves reservations held and a half-built org, so
 * every step runs through OrganizationSagaService with a `done` set that lets a
 * replay skip what already committed and a compensation path that releases the
 * slug, releases the id and unplaces the org.
 *
 * bootstrapCellOrganization is not exported: it is a saga step, and running it
 * outside the saga is how a half-built organisation gets left behind. It is
 * idempotent on its own account too — it returns early when the organizations
 * row is already there — because a resumed saga may re-enter it.
 */
export interface OrgCreationDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly saga: OrganizationSagaService;
  readonly indexService: AccountOrganizationIndexService;
}

export async function createOrganization(
  deps: OrgCreationDeps,
  userId: string,
  input: CreateOrganizationInput,
) {
  let billingEmail: string | null = input.billingEmail ?? null;
  if (!billingEmail) {
    const [actor] = await deps.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    billingEmail = actor?.email ?? null;
  }
  const requestKey = `create:${userId}:${input.slug}`;
  const { saga, steps } = await deps.saga.begin(
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
  const region = (await chooseRegionForNewOrg(deps.db, { organizationId: orgId })).region;

  try {
    if (!done.has("reserve-identity"))
      await deps.saga.runStep(saga.sagaId, "reserve-identity", async () => {
        const idReserved = await deps.saga.reserve(
          "ORGANIZATION_ID",
          orgId,
          orgId,
          saga.sagaId,
        );
        if (!idReserved)
          throw new ConflictException("Organization id is already reserved");

        try {
          const slugReserved = await deps.saga.reserve(
            "SLUG",
            input.slug,
            orgId,
            saga.sagaId,
          );
          if (!slugReserved)
            throw new ConflictException("Organization slug already exists");
        } catch (error) {
          await deps.saga.release("ORGANIZATION_ID", orgId);
          throw error;
        }
      });

    if (!done.has("reserve-placement"))
      await deps.saga.runStep(saga.sagaId, "reserve-placement", () =>
        placeOrganization(deps.db, { orgId, region }),
      );

    if (!done.has("bootstrap-cell-organization"))
      await deps.saga.runStep(
        saga.sagaId,
        "bootstrap-cell-organization",
        () =>
          bootstrapCellOrganization(
            deps,
            orgId,
            userId,
            region,
            billingEmail,
            input,
          ),
      );

    if (!done.has("bootstrap-owner-membership"))
      await deps.saga.runStep(saga.sagaId, "bootstrap-owner-membership", async () => {
        const [owner] = await runInNewTenantTransaction(deps.db, orgId, (tx) =>
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
      await deps.saga.runStep(saga.sagaId, "activate-directory-projection", async () => {
        await deps.indexService.refreshForUser(userId);
        await deps.indexService.touchLastActivated(userId, orgId);
      });

    await deps.saga.complete(saga.sagaId);
    await deps.saga.claim("ORGANIZATION_ID", orgId);
    await deps.saga.claim("SLUG", input.slug);
  } catch (error) {
    await deps.saga.compensate(saga.sagaId, {
      "reserve-identity": async () => {
        await deps.saga.release("SLUG", input.slug);
        await deps.saga.release("ORGANIZATION_ID", orgId);
      },
      "reserve-placement": () => unplaceOrganization(deps.db, orgId),
    });
    throw error;
  }

  await deps.cache.invalidate(CACHE_KEYS.userSession(userId));

  return { id: orgId, name: input.name, slug: input.slug };
}

async function bootstrapCellOrganization(
  deps: OrgCreationDeps,
  orgId: string,
  userId: string,
  region: string,
  billingEmail: string | null,
  input: CreateOrganizationInput,
): Promise<void> {
  await runInNewTenantTransaction(deps.db, orgId, async (tx) => {
    const [already] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (already) return;

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
    await seedSystemRolesForOrg(deps.db, orgId);
    await provisionOrgModules(tx, orgId, DEFAULT_SKIP_MODULES, userId);
    await tx
      .update(users)
      .set({ lastActiveOrgId: orgId })
      .where(eq(users.id, userId));
  });
}
