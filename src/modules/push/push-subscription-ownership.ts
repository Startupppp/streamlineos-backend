import type { IndexColumn } from "drizzle-orm/pg-core";
import { pushSubscriptions } from "../../db/schema";

/**
 * The arbiter for the push-subscription upsert, and the columns a conflicting row
 * must be re-owned by.
 *
 * ARBITER. `push_subscriptions_endpoint_unique` is a TOTAL unique constraint on
 * `endpoint` alone (verified against the catalog by the spec beside this file), so
 * unlike `uniq_chat_messages_client_key` a bare column target CAN infer it and no
 * arbiter predicate is needed. That is deliberate rather than accidental: a browser
 * push endpoint is the natural key of one browser, and one browser has one current
 * subscriber. `onConflictDoUpdate` reads `targetWhere` where `onConflictDoNothing`
 * reads `where` (drizzle-orm 0.45.2); neither is spelled here because the index is
 * total, and the spec asserts that it still is.
 *
 * OWNERSHIP. The head form set only `p256dh` and `auth`, so a conflicting row kept
 * the FIRST subscriber's `user_id`, `org_id` and `membership_id` while carrying the
 * SECOND subscriber's keys. Measured against scratch_head_1010 as `streamline_app`:
 * after U2 subscribes from a browser U1 had registered, the row still reads
 * `user_id = U1`, so `WebPushService.sendToUser(org, U1, …)` pushes U1's
 * notifications to U2's browser, and `PushService.unsubscribe(endpoint, U2)` deletes
 * 0 rows — U2 cannot stop it.
 *
 * `membershipId` is set to null with the rest, not omitted. `push_subscriptions` has
 * a composite FK `(org_id, membership_id) → organization_members(org_id, id)`, so a
 * row whose `org_id` moves to another tenant while `membership_id` still names the
 * old tenant's membership is a foreign-key violation; and a stale `membership_id`
 * would keep matching `WebPushService.subscriptionPredicate`'s membership arm for
 * the PREVIOUS owner even after `user_id` moved. The owning columns move together or
 * the row is inconsistent.
 */
export const PUSH_ENDPOINT_CONFLICT: { target: IndexColumn[] } = {
  target: [pushSubscriptions.endpoint],
};

export interface PushEndpointOwner {
  userId: string;
  orgId: string;
  p256dh: string;
  auth: string;
  userAgent?: string | undefined;
}

/** Every column that says who this browser registration now belongs to. */
export function pushSubscriptionOwnership(owner: PushEndpointOwner): {
  userId: string;
  orgId: string;
  membershipId: null;
  p256dh: string;
  auth: string;
  userAgent: string | null;
} {
  return {
    userId: owner.userId,
    orgId: owner.orgId,
    membershipId: null,
    p256dh: owner.p256dh,
    auth: owner.auth,
    userAgent: owner.userAgent ?? null,
  };
}
