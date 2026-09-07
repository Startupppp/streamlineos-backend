import { sql, type SQL } from "drizzle-orm";

export function seatCount(orgId: string): SQL<number> {
  return sql<number>`(
    (SELECT COUNT(*)::int FROM organization_members WHERE org_id = ${orgId}) +
    (SELECT COUNT(*)::int FROM invitations
     WHERE org_id = ${orgId}
       AND status = 'PENDING'
       AND accepted_at IS NULL
       AND expires_at > NOW())
  )::int`;
}

function quotaLockKey(orgId: string, limitKey: string): string {
  return `quota:${orgId}:${limitKey}`;
}

/**
 * Serialises a plan-limit check against the insert it guards.
 *
 * `assertWithinLimit` is check-then-act on its own: N concurrent creates at the
 * ceiling all read the same `used` and all succeed. Held for the length of the
 * transaction that does the insert — and with the same transaction handed to
 * `assertWithinLimit` so the count reads through it — the check and the write
 * become one serialized invariant.
 */
function lockQuota(orgId: string, limitKey: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${quotaLockKey(orgId, limitKey)}, 0))`;
}

export function membersQuotaLockKey(orgId: string): string {
  return quotaLockKey(orgId, "members");
}

export function lockMembersQuota(orgId: string): SQL {
  return lockQuota(orgId, "members");
}

export const SEAT_EVENT_TYPES = [
  "INVITE_SENT",
  "INVITE_ACCEPTED",
  "INVITE_EXPIRED",
  "INVITE_CANCELLED",
  "MEMBER_SUSPENDED",
  "MEMBER_REACTIVATED",
  "MEMBER_DEACTIVATED",
  "GUEST_ADDED",
  "GUEST_REMOVED",
] as const;

export type SeatEventType = (typeof SEAT_EVENT_TYPES)[number];

/** `quantity_delta` is looked up here, never chosen by a caller, so the inclusion rules cannot drift per call site. */
export const SEAT_EVENT_DELTAS: Record<SeatEventType, number> = {
  INVITE_SENT: 1,
  INVITE_ACCEPTED: 0,
  INVITE_EXPIRED: -1,
  INVITE_CANCELLED: -1,
  MEMBER_SUSPENDED: 0,
  MEMBER_REACTIVATED: 0,
  MEMBER_DEACTIVATED: -1,
  GUEST_ADDED: 1,
  GUEST_REMOVED: -1,
};
