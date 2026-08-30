export const NOTIFICATION_CATALOG_COHESIVE_EXCEPTION = {
  file: "notification-events.catalog.ts",
  linesAtRegistration: 1054,
  interface: "NotificationEventDefinition[]",
  reason:
    "Pure event-data catalog identical in structure to the permission catalogs declared in CLAUDE.md §7. " +
    "Every entry is the same notificationEvent() helper call — no delivery logic, policy logic, or behavior is mixed in. " +
    "CHAT and BUILD domain groups have already been extracted to separate catalog files; the remaining 18 domains are coherent here. " +
    "Splitting further would produce 18 files each averaging ~55 lines of identical-structure data, offering no cohesion gain.",
  owner: "notifications",
  rule: "CLAUDE.md §7 — a cohesive catalog may exceed 500 lines rather than split artificially",
} as const;
