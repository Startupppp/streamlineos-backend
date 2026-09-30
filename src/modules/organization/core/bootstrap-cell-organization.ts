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
import { ensureManyFromUsers } from "../../hr/core/person-employment-sync-batch";
import { toEnsureInput } from "../../hr/core/person-employment-sync.types";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";

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
  /** BUG-HRMS-009. Undefined or null leaves the column default in place. */
  country?: string | null;
  timezone?: string | null;
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
        // Spread so an absent value keeps the column default rather than
        // overwriting `Asia/Kolkata` with null on a NOT NULL column.
        ...(input.country ? { country: input.country } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
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
      await provisionOwnerEmployment(tx, orgId, userId);
      await tx
        .update(users)
        .set({ lastActiveOrgId: orgId })
        .where(eq(users.id, userId));
    }),
  );
}

/**
 * The founder's own employment record, created with the organisation.
 *
 * Nothing used to create one. An owner is a member and a user, but not an
 * employee — and every HR surface that asks "who is this person at work" reads
 * `hr_employments`. Three separate failures in the QA audit are the same
 * absence:
 *
 *   - a bulk onboarding file naming the owner as `reportingManagerEmail` failed
 *     every dependent row with "manager has no employment record";
 *   - `ApprovalAuthorityService` skipped the owner as a leave approver with
 *     `manager-has-no-employment`, and with nobody else in the org the chain
 *     resolved to nothing and the submit button went dead;
 *   - the owner's own directory row exported with empty employment columns.
 *
 * An Indian SMB founder is usually not hired as an employee of their own
 * company, so waiting for someone to onboard them is not a workaround — the
 * record has to exist from the start. `ensureManyFromUsers` is the same
 * idempotent path the single-hire form and the backfill use, so an org created
 * before this change converges on the same shape the first time the backfill
 * runs, and running it twice changes nothing.
 *
 * `PRE_JOINING` rather than ACTIVE: the founder is on record as a person at
 * work without being counted as a hire in headcount or attrition.
 */
async function provisionOwnerEmployment(
  tx: DbOrTx,
  orgId: string,
  userId: string,
): Promise<void> {
  const [owner] = await tx
    .select({
      email: users.email,
      name: users.name,
      firstName: users.firstName,
      lastName: users.lastName,
      phone: users.phone,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!owner) return;

  await ensureManyFromUsers(tx, orgId, [
    toEnsureInput({ userId, ...owner }, "PRE_JOINING"),
  ]);
}
