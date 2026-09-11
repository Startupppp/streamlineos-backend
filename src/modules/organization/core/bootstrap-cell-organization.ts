import { eq } from "drizzle-orm";
import { addDays } from "date-fns";
import { organizations, subscriptions, users } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { withMembershipMutations } from "../../../common/org/membership-mutations";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";
import {
  getTrialDays,
  TRIAL_PLAN,
} from "../../billing/core/plan-entitlements.constants";
import {
  DEFAULT_SKIP_MODULES,
  provisionOrgModules,
} from "../../../common/org/provision-org-modules";
import { provisionEmployeeSelfService } from "../../../common/org/provision-employee-self-service";
import { seedSystemRolesForOrg } from "../../rbac/seed-system-roles";

export function generateOrgSlug(
  name: string,
  suffix = Date.now().toString(36),
): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 50) +
    "-" +
    suffix
  );
}

export interface BootstrapCellOrganizationInput {
  orgId: string;
  userId: string;
  region: string;
  name: string;
  slug: string;
  billingEmail?: string | null;
  onboardingCompletedAt?: Date | null;
  ownerActivatedAt?: Date | null;
  moduleKeys?: readonly string[];
}

export async function bootstrapCellOrganization(
  db: Db,
  cache: CacheService,
  input: BootstrapCellOrganizationInput,
): Promise<void> {
  const { orgId, userId } = input;
  const moduleKeys = input.moduleKeys ?? DEFAULT_SKIP_MODULES;

  await withMembershipMutations(cache, (membership) =>
    runInNewTenantTransaction(db, orgId, async (tx) => {
      const [already] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (already) return;

      const ownerMembershipId = await membership.allocateMembershipId(tx);
      await tx.insert(organizations).values({
        id: orgId,
        region: input.region,
        name: input.name,
        slug: input.slug,
        billingEmail: input.billingEmail ?? null,
        ownerMembershipId,
        onboardingCompletedAt: input.onboardingCompletedAt ?? null,
      });
      await membership.createOwnerMembership(tx, {
        orgId,
        userId,
        membershipId: ownerMembershipId,
        role: ORG_MEMBER_ROLES.OWNER,
        ...(input.ownerActivatedAt ? { activatedAt: input.ownerActivatedAt } : {}),
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
      await seedSystemRolesForOrg(db, orgId);
      await provisionOrgModules(tx, orgId, moduleKeys, userId);
      await tx
        .update(users)
        .set({ lastActiveOrgId: orgId })
        .where(eq(users.id, userId));
    }),
  );
}
