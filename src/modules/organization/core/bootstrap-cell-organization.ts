import { eq, sql } from "drizzle-orm";
import { organizations, users } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { withMembershipMutations } from "../../../common/org/membership-mutations";
import { insertTrialSubscription } from "../../billing/core/trial-subscription";
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
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`organization-bootstrap:${orgId}`}, 0))`,
      );
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
      await insertTrialSubscription(tx, orgId);
      await provisionEmployeeSelfService(tx, orgId);
      await seedSystemRolesForOrg(db, orgId);
      await provisionOrgModules(tx, orgId, moduleKeys, userId);
      await tx
        .update(users)
        .set({ lastActiveOrgId: orgId })
        .where(eq(users.id, userId));
    }),
  );
}
