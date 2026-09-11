import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { pushSubscriptions } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

/**
 * How many recipients one `push_subscriptions` read covers. The fan-out used to
 * issue one SELECT per recipient — 5,000 members meant 5,000 round trips for a
 * single message — which is the per-item database call
 * `check:db-call-count` and PRD-C145 both forbid. One read per page of this size
 * replaces them; the page is kept well inside Postgres' bind-parameter ceiling
 * so the `IN (…)` list never has to be split again downstream.
 */
export const PUSH_SUBSCRIPTION_BATCH = 200;

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Org-led: a person in two organizations has a subscription row per organization,
 * so matching on user alone pushes one tenant's notification to the other's device
 * registration and leaves the (org_id, membership_id) index unusable.
 */
export function subscriptionPredicate(
  orgId: string,
  userId: string,
  membershipId: number | null | undefined,
) {
  const owner =
    membershipId != null
      ? or(
          eq(pushSubscriptions.membershipId, membershipId),
          and(isNull(pushSubscriptions.membershipId), eq(pushSubscriptions.userId, userId)),
        )
      : eq(pushSubscriptions.userId, userId);
  return and(eq(pushSubscriptions.orgId, orgId), owner);
}

export async function loadSubscriptionsForUser(
  db: Db,
  orgId: string,
  userId: string,
  membershipId: number | null | undefined,
): Promise<PushSubscriptionRow[]> {
  return db
    .select({
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .where(subscriptionPredicate(orgId, userId, membershipId));
}

/**
 * One read for a whole page of recipients. Org-scoped for the same reason
 * `subscriptionPredicate` is: a person in two organizations holds a row per
 * organization, and matching on user alone crosses the tenant boundary.
 */
export async function loadSubscriptionsForPage(
  db: Db,
  orgId: string,
  userIds: readonly string[],
): Promise<Map<string, PushSubscriptionRow[]>> {
  const byUser = new Map<string, PushSubscriptionRow[]>();
  if (userIds.length === 0) return byUser;
  const rows = await db
    .select({
      userId: pushSubscriptions.userId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.orgId, orgId), inArray(pushSubscriptions.userId, [...userIds])));
  for (const row of rows) {
    const existing = byUser.get(row.userId);
    const sub = { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth };
    if (existing) existing.push(sub);
    else byUser.set(row.userId, [sub]);
  }
  return byUser;
}

/**
 * Prune the registrations a push service has reported as gone (404/410). Scoped
 * by `org_id` for the same tenant reason the read predicate is: an endpoint
 * string is globally unique to a browser, so an unscoped delete would drop the
 * row a second organization holds for the same device.
 */
export async function deleteExpiredSubscriptions(
  db: Db,
  orgId: string,
  endpoints: readonly string[],
): Promise<void> {
  if (endpoints.length === 0) return;
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.orgId, orgId), inArray(pushSubscriptions.endpoint, [...endpoints])));
}
