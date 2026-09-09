import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { organizationMembers, users } from "../../db/schema";

/**
 * The name to print beside a rep's numbers, and nothing else about them.
 *
 * A shared function rather than a method on either service, because both the
 * per-rep aggregate and the exemplar list need it and a second copy would be a
 * second projection — which is the specific way this table goes wrong. `users`
 * is the global identity table: it still carries authentication secrets and
 * legacy payroll columns, and the house rule is that no relation to it is ever
 * unprojected. Two columns are selected here and there is no shape in which a
 * third arrives by accident.
 *
 * The join to `organization_members` is not decoration. `users` is global, so
 * selecting by id alone would resolve a name for any user id that reached this
 * function from anywhere — and the ids reaching it come from
 * `activities.actor_user_id`, which is deliberately not a foreign key and can
 * therefore name somebody who was never in this organisation. Requiring an
 * active membership row in *this* org is what makes a cross-tenant id resolve to
 * nothing rather than to a name.
 *
 * A missing name is returned as an absent map entry rather than as a
 * placeholder. The caller decides what to render for somebody who has left,
 * because "Unknown" in a coaching table and "Unknown" in an export are different
 * mistakes, and neither belongs to this function.
 */
export async function resolveRepNames(
  db: Db,
  organizationId: string,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;

  const rows = await db
    .select({ userId: users.id, name: users.name })
    .from(users)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.userId, users.id),
        eq(organizationMembers.orgId, organizationId),
      ),
    )
    .where(inArray(users.id, ids));

  for (const row of rows) {
    const name = row.name?.trim();
    if (name) out.set(row.userId, name);
  }

  return out;
}
