export interface RequestActorContext {
  orgId: string;
  userId: string;
  membershipId?: number | null;
  ipAddress?: string;
  userAgent?: string;
}
