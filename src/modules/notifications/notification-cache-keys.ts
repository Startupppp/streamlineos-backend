/** Redis keys for org-scoped notification-engine data read on every dispatch but changed rarely. */
export const NOTIF_CACHE = {
  availability: (orgId: string): string => `notif:avail:${orgId}`,
  policy: (orgId: string): string => `notif:policy:${orgId}`,
  events: (orgId: string): string => `notif:events:${orgId}`,
} as const;
