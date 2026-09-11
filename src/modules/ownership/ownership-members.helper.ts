import { and, eq, inArray } from "drizzle-orm";
import { organizationMembers } from "../../db/schema";
import type { DbOrTx } from "../../common/rbac/access-invalidate";

type MembershipRow = typeof organizationMembers.$inferSelect;

export interface OwnershipMembership {
  id: number;
  userId: string;
  isOwner: boolean;
  status: MembershipRow["status"];
}

export async function fetchMembershipByUser(
  db: DbOrTx,
  orgId: string,
  userId: string,
): Promise<OwnershipMembership | null> {
  const [row] = await db
    .select({
      id: organizationMembers.id,
      userId: organizationMembers.userId,
      isOwner: organizationMembers.isOwner,
      status: organizationMembers.status,
    })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function fetchMembershipById(
  db: DbOrTx,
  orgId: string,
  membershipId: number,
): Promise<OwnershipMembership | null> {
  const [row] = await db
    .select({
      id: organizationMembers.id,
      userId: organizationMembers.userId,
      isOwner: organizationMembers.isOwner,
      status: organizationMembers.status,
    })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.id, membershipId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Transfers reference memberships, notifications target users. Resolves within
 * the tenant so a membership id from another org can never widen the audience.
 */
/**
 * The same read, keyed, so a caller with MANY memberships resolves them once.
 *
 * `resolveMembershipUserIds` flattens to a `string[]`, which loses which
 * membership produced which user — so a caller needing that correspondence had
 * to call it once per row. `ownership-transfer-expiry` did exactly that, one
 * indexed read per expired transfer.
 */
export async function resolveMembershipUserIdMap(
  db: DbOrTx,
  orgId: string,
  membershipIds: readonly number[],
): Promise<Map<number, string>> {
  const unique = Array.from(new Set(membershipIds));
  if (unique.length === 0) return new Map();

  const rows = await db
    .select({ id: organizationMembers.id, userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        inArray(organizationMembers.id, unique),
      ),
    );

  return new Map(rows.map((row) => [row.id, row.userId]));
}

export async function resolveMembershipUserIds(
  db: DbOrTx,
  orgId: string,
  membershipIds: readonly number[],
): Promise<string[]> {
  const unique = Array.from(new Set(membershipIds));
  if (unique.length === 0) return [];

  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        inArray(organizationMembers.id, unique),
      ),
    );

  return Array.from(new Set(rows.map((row) => row.userId)));
}
