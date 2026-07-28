import type { Permission } from "./types";

export const FEEDBUCKET_PERMISSIONS: Permission[] = [
  {
    name: "feedbucket:widgets:view",
    resource: "feedbucket:widgets",
    action: "view",
    description: "View feedback widgets",
  },
  {
    name: "feedbucket:widgets:create",
    resource: "feedbucket:widgets",
    action: "create",
    description: "Create feedback widgets",
  },
  {
    name: "feedbucket:widgets:update",
    resource: "feedbucket:widgets",
    action: "update",
    description: "Update feedback widgets",
  },
  {
    name: "feedbucket:widgets:delete",
    resource: "feedbucket:widgets",
    action: "delete",
    description: "Delete feedback widgets",
  },
  {
    name: "feedbucket:widgets:manage",
    resource: "feedbucket:widgets",
    action: "manage",
    description: "Manage feedback widgets (rotate keys, etc.)",
  },
  {
    name: "feedbucket:submissions:view",
    resource: "feedbucket:submissions",
    action: "view",
    description: "View feedback submissions",
  },
  {
    name: "feedbucket:submissions:update",
    resource: "feedbucket:submissions",
    action: "update",
    description: "Update feedback submissions",
  },
  {
    name: "feedbucket:submissions:delete",
    resource: "feedbucket:submissions",
    action: "delete",
    description: "Delete feedback submissions",
  },
  {
    name: "feedbucket:submissions:manage",
    resource: "feedbucket:submissions",
    action: "manage",
    description: "Manage feedback submissions (convert to ticket, etc.)",
  },
  {
    name: "feedbucket:submissions:assign",
    resource: "feedbucket:submissions",
    action: "assign",
    description: "Assign feedback submissions to team members",
  },
  {
    name: "feedbucket:submissions:ai",
    resource: "feedbucket:submissions",
    action: "ai",
    description: "Run AI triage analysis on feedback submissions",
  },
];
