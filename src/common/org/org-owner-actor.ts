import { eq } from "drizzle-orm";
import { organizationMembers, organizations } from "../../db/schema";
import { type DbOrTx } from "../rbac/access-invalidate";

/**
 * The organisation's owner, as a `users.id`.
 *
 * Wanted wherever a system-initiated write has to name an accountable person
 * and there is none — a candidate accepting an offer is not a member, and
 * `"system"` is not a user. Both `audit_logs.user_id` and
 * `billing_seat_events.actor_id` carry an FK to `users.id`, so the sentinel is
 * not merely untidy: it makes the row impossible to write, which for the audit
 * means the record of what happened is the thing that goes missing.
 */
export async function orgOwnerUserId(db: DbOrTx, orgId: string): Promise<string | null> {
  const [owner] = await db
    .select({ userId: organizationMembers.userId })
    .from(organizations)
    .innerJoin(organizationMembers, eq(organizationMembers.id, organizations.ownerMembershipId))
    .where(eq(organizations.id, orgId))
    .limit(1);
  return owner?.userId ?? null;
}
