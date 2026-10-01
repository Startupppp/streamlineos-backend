import { definePermissions } from "./types";

export const NOTIFICATIONS_PERMISSIONS = definePermissions([
  {
    name: "notifications:events:view",
    resource: "notifications:events",
    action: "view",
    description: "View the notification event catalog",
  },
  {
    name: "notifications:events:manage",
    resource: "notifications:events",
    action: "manage",
    description: "Edit event policy and emit test events",
  },
  {
    name: "notifications:providers:view",
    resource: "notifications:providers",
    action: "view",
    description: "View notification providers",
  },
  {
    name: "notifications:providers:manage",
    resource: "notifications:providers",
    action: "manage",
    description: "Configure, test, and remove notification providers",
  },
  {
    name: "notifications:policy:view",
    resource: "notifications:policy",
    action: "view",
    description: "View notification policy defaults",
  },
  {
    name: "notifications:policy:manage",
    resource: "notifications:policy",
    action: "manage",
    description: "Set organization notification policy defaults",
  },
  {
    name: "notifications:templates:view",
    resource: "notifications:templates",
    action: "view",
    description: "View notification templates",
  },
  {
    name: "notifications:templates:manage",
    resource: "notifications:templates",
    action: "manage",
    description: "Create, edit, and delete notification templates",
  },
  {
    name: "notifications:broadcasts:view",
    resource: "notifications:broadcasts",
    action: "view",
    description: "View broadcasts",
  },
  {
    name: "notifications:broadcasts:manage",
    resource: "notifications:broadcasts",
    action: "manage",
    description: "Create, schedule, send, and cancel broadcasts",
  },
]);
