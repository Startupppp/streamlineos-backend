import { sql, type SQL } from "drizzle-orm";

/** One definition — accepted members plus non-expired pending invitations — shared by enforcement, the ledger and display. */
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

/** The per-organisation key every seat change and every seat quota check serializes under. */
export function membersQuotaLockKey(orgId: string): string {
  return `quota:${orgId}:members`;
}

/** Transaction-scoped, so it releases on commit or rollback and never leaks a held lock. */
export function lockMembersQuota(orgId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${membersQuotaLockKey(orgId)}, 0))`;
}

export type SeatEventType =
  | "INVITE_SENT"
  | "INVITE_ACCEPTED"
  | "INVITE_EXPIRED"
  | "INVITE_CANCELLED"
  | "MEMBER_SUSPENDED"
  | "MEMBER_REACTIVATED"
  | "MEMBER_DEACTIVATED"
  | "GUEST_ADDED"
  | "GUEST_REMOVED";

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

export const SEAT_EVENT_TYPES = Object.keys(SEAT_EVENT_DELTAS) as SeatEventType[];
