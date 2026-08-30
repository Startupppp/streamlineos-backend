import type { Permission } from "./types";

export const CALENDAR_PERMISSIONS: Permission[] = [
  {
    name: "calendar:read",
    resource: "calendar",
    action: "read",
    description: "View calendar events",
  },
  {
    name: "calendar:write",
    resource: "calendar",
    action: "write",
    description: "Create and manage calendar events",
  },
  {
    name: "calendar:ai:use",
    resource: "calendar:ai",
    action: "use",
    description: "Use AI meeting preparation and follow-up features",
  },
  {
    name: "calendar:events:export",
    resource: "calendar:events",
    action: "export",
    description: "Export organisation calendar events as CSV",
  },
  {
    name: "calendar:admin:manage",
    resource: "calendar:admin",
    action: "manage",
    description: "Configure organisation-wide calendar settings and sources",
  },
];
