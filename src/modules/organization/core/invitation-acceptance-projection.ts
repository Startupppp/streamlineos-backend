import { Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { withIdentity } from "../../../common/tenant/with-identity";
import { LEGACY_CELL_ID } from "../../../common/region/placement";
import { type Db } from "../../../db/drizzle.module";
import {
  accountOrganizationIndex,
  organizationMembers,
  organizations,
} from "../../../db/schema";

async function touchIndexLastActivated(
  db: Db,
  orgId: string,
  userId: string,
): Promise<boolean> {
  // Public accept route: no ambient GUC, so only `withIdentity` lets the members policy match.
  const [org, membership] = await withIdentity(db, userId, (tx) =>
    Promise.all([
      tx.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { name: true, slug: true, region: true, status: true },
      }),
      tx.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.orgId, orgId),
        ),
        columns: { role: true, status: true, joinedAt: true },
      }),
    ]),
  );
  if (!org || !membership) return false;
  await withIdentity(db, userId, (tx) =>
    tx
      .insert(accountOrganizationIndex)
      .values({
        userId,
        orgId,
        cellId: LEGACY_CELL_ID,
        region: org.region ?? "primary",
        organizationName: org.name,
        organizationSlug: org.slug,
        membershipRole: membership.role,
        membershipStatus: membership.status,
        organizationStatus: org.status,
        joinedAt: membership.joinedAt,
        lastActivatedAt: new Date(),
        projectedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [accountOrganizationIndex.userId, accountOrganizationIndex.orgId],
        set: {
          membershipRole: sql`excluded.membership_role`,
          membershipStatus: sql`excluded.membership_status`,
          organizationStatus: sql`excluded.organization_status`,
          joinedAt: sql`excluded.joined_at`,
          lastActivatedAt: sql`excluded.last_activated_at`,
          projectedAt: sql`excluded.projected_at`,
        },
      }),
  );
  return true;
}

/**
 * A failed projection is never fatal to a membership that already committed,
 * but it must not be silent either: `OrgProfileService.listUserOrganizations`
 * only falls back to `organization_members` when the account has no projected
 * organization at all, so an account that already belongs elsewhere keeps a
 * stale list until the projection is rebuilt.
 */
export async function projectAcceptedMembership(
  db: Db,
  logger: Logger,
  orgId: string,
  userId: string,
): Promise<void> {
  const failure = await touchIndexLastActivated(db, orgId, userId).then(
    (recorded) => (recorded ? null : "no organization or membership row was readable"),
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  if (failure === null) return;
  logger.error(
    `account-organization-index projection failed after acceptance for org ${orgId} user ${userId}: ${failure}`,
  );
}
