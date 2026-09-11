/**
 * The census half of `verify-membership-revocation`: how many artifact rows one
 * membership still owns.
 *
 * `snapshot` counts the same ten artifacts before and after a revocation and
 * `buildResults` turns the pair into a verdict — after must be zero. Separate
 * from the drift check in `./fk-drift` because the two fail for unrelated
 * reasons: this one is wrong when a count query names the wrong column, that one
 * when the declared inventory and the real constraint disagree.
 *
 * `printUncoveredArtifacts` is the anti-vacuity floor. `ARTIFACT_COVERAGE` lists
 * what `snapshot` actually counts, and anything in `MEMBERSHIP_ARTIFACTS` that
 * cascades but is missing from that set is printed — so an artifact added to the
 * inventory cannot quietly go unchecked here while the script still reports PASS.
 *
 * The delegation id is a parameter rather than the module constant it used to
 * read: the scenario that mints it lives in the script, and importing it back
 * from there would close a cycle.
 */

import { and, count, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import {
  agentTokens,
  invitations,
  kbSpaceGrants,
  principalGroupMembers,
  resourceGrants,
  roleAssignments,
  userDelegationPermissions,
  userDelegations,
  userModuleAccess,
  userPermissionGrants,
} from "../../db/schema";
import { MEMBERSHIP_ARTIFACTS } from "../../modules/organization/core/membership-artifacts";

type CountRow = { n: unknown };
const toN = (r: CountRow | undefined): number => Number(r?.n ?? 0);

export type ArtifactResult = { table: string; before: number; after: number; status: "PASS" | "FAIL" };

export function buildResults(
  before: Record<string, number>,
  after: Record<string, number>,
): ArtifactResult[] {
  return Object.keys(before).map((table) => ({
    table,
    before: before[table] ?? 0,
    after: after[table] ?? 0,
    status: (after[table] ?? 0) === 0 ? "PASS" : "FAIL",
  }));
}

export async function snapshot(
  db: Db,
  orgId: string,
  membershipId: number,
  userId: string,
  email: string,
  delegationId: string,
): Promise<Record<string, number>> {
  return runInNewTenantTransaction(db, orgId, async (tx) => {
    const [ra] = await tx
      .select({ n: count() })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.orgId, orgId), eq(roleAssignments.organizationMembershipId, membershipId)));
    const [upg] = await tx
      .select({ n: count() })
      .from(userPermissionGrants)
      .where(and(eq(userPermissionGrants.orgId, orgId), eq(userPermissionGrants.organizationMembershipId, membershipId)));
    const [pgm] = await tx
      .select({ n: count() })
      .from(principalGroupMembers)
      .where(and(eq(principalGroupMembers.orgId, orgId), eq(principalGroupMembers.organizationMembershipId, membershipId)));
    const [uma] = await tx
      .select({ n: count() })
      .from(userModuleAccess)
      .where(and(eq(userModuleAccess.orgId, orgId), eq(userModuleAccess.organizationMembershipId, membershipId)));
    const [ud] = await tx
      .select({ n: count() })
      .from(userDelegations)
      .where(
        and(
          eq(userDelegations.orgId, orgId),
          or(eq(userDelegations.delegatorMembershipId, membershipId), eq(userDelegations.delegateeMembershipId, membershipId)),
        ),
      );
    const [udp] = await tx
      .select({ n: count() })
      .from(userDelegationPermissions)
      .where(and(eq(userDelegationPermissions.orgId, orgId), eq(userDelegationPermissions.delegationId, delegationId)));
    const [at] = await tx
      .select({ n: count() })
      .from(agentTokens)
      .where(and(eq(agentTokens.orgId, orgId), eq(agentTokens.issuerMembershipId, membershipId)));
    const [rg] = await tx
      .select({ n: count() })
      .from(resourceGrants)
      .where(and(eq(resourceGrants.orgId, orgId), eq(resourceGrants.principalType, "user"), eq(resourceGrants.principalId, userId)));
    const [ksg] = await tx
      .select({ n: count() })
      .from(kbSpaceGrants)
      .where(and(eq(kbSpaceGrants.orgId, orgId), eq(kbSpaceGrants.principalType, "user"), eq(kbSpaceGrants.principalId, userId)));
    const [inv] = await tx
      .select({ n: count() })
      .from(invitations)
      .where(
        and(eq(invitations.orgId, orgId), eq(invitations.email, email), eq(invitations.status, "PENDING"), isNull(invitations.acceptedAt)),
      );
    return {
      role_assignments: toN(ra),
      user_permission_grants: toN(upg),
      principal_group_members: toN(pgm),
      user_module_access: toN(uma),
      user_delegations: toN(ud),
      user_delegation_permissions: toN(udp),
      agent_tokens: toN(at),
      resource_grants: toN(rg),
      kb_space_grants: toN(ksg),
      invitations_pending: toN(inv),
    };
  });
}

const ARTIFACT_COVERAGE: ReadonlySet<string> = new Set([
  "role_assignments", "user_permission_grants", "principal_group_members",
  "user_delegations", "user_module_access", "agent_tokens",
  "resource_grants", "kb_space_grants", "invitations",
]);

export function printUncoveredArtifacts(): void {
  const uncovered = MEMBERSHIP_ARTIFACTS.filter(
    (a) => a.table !== null && a.onRemoval !== "blocks-removal" && a.onRemoval !== "set-null" && !ARTIFACT_COVERAGE.has(a.table),
  );
  if (uncovered.length > 0) {
    console.log("\nNOTICE — inventory artifacts not checked by this script:");
    uncovered.forEach((a) => console.log(`  ${a.table ?? ""} (${a.id})`));
  }
}
