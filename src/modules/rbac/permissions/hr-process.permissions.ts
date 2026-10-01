import { definePermissions } from "./types";

export const HR_PROCESS_PERMISSIONS = definePermissions([
  {
    name: "hr:automations:view",
    resource: "hr:automations",
    action: "view",
    description: "View HR automation rules and run logs",
  },
  {
    name: "hr:automations:manage",
    resource: "hr:automations",
    action: "manage",
    description: "Manage HR automation rules",
  },
  {
    name: "hr:policies:view",
    resource: "hr:policies",
    action: "view",
    description: "View HR policies",
  },
  {
    name: "hr:policies:manage",
    resource: "hr:policies",
    action: "manage",
    description: "Create, update, activate, and archive HR policies",
  },
  {
    name: "hr:workflows:view",
    resource: "hr:workflows",
    action: "view",
    description: "View HR approval workflows and instances",
  },
  {
    name: "hr:workflows:manage",
    resource: "hr:workflows",
    action: "manage",
    description: "Manage HR approval workflow definitions",
  },
  {
    name: "hr:workflows:approve",
    resource: "hr:workflows",
    action: "approve",
    description: "Act on HR workflow approvals",
  },
  {
    name: "hr:templates:view",
    resource: "hr:templates",
    action: "view",
    description: "View HR templates",
  },
  {
    name: "hr:templates:manage",
    resource: "hr:templates",
    action: "manage",
    description: "Create and manage HR templates",
  },
  {
    name: "hr:interviews:view",
    resource: "hr:interviews",
    action: "view",
    description: "View interviews and scorecards",
  },
  {
    name: "hr:interviews:manage",
    resource: "hr:interviews",
    action: "manage",
    description: "Schedule interviews and submit scorecards",
  },
  {
    name: "hr:offers:view",
    resource: "hr:offers",
    action: "view",
    description: "View candidate offers",
  },
  {
    name: "hr:offers:manage",
    resource: "hr:offers",
    action: "manage",
    description: "Create, edit, and submit offers for approval",
  },
  {
    name: "hr:offers:approve",
    resource: "hr:offers",
    action: "approve",
    description: "Approve or reject offers submitted for approval",
  },
]);
