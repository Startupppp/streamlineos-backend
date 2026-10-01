import { definePermissions } from "./types";

export const WORKFLOW_PERMISSIONS = definePermissions([
  {
    name: "workflows:workflows:view",
    resource: "workflows:workflows",
    action: "view",
    description: "View workflows",
  },
  {
    name: "workflows:workflows:create",
    resource: "workflows:workflows",
    action: "create",
    description: "Create workflows",
  },
  {
    name: "workflows:workflows:update",
    resource: "workflows:workflows",
    action: "update",
    description: "Update workflows",
  },
  {
    name: "workflows:workflows:delete",
    resource: "workflows:workflows",
    action: "delete",
    description: "Delete workflows",
  },
  {
    name: "workflows:workflows:publish",
    resource: "workflows:workflows",
    action: "publish",
    description: "Publish workflows",
  },
  {
    name: "workflows:executions:view",
    resource: "workflows:executions",
    action: "view",
    description: "View workflow executions",
  },
  {
    name: "workflows:executions:manage",
    resource: "workflows:executions",
    action: "manage",
    description: "Cancel or retry workflow executions",
  },
  {
    name: "workflows:approvals:view",
    resource: "workflows:approvals",
    action: "view",
    description: "View workflow approvals",
  },
  {
    name: "workflows:approvals:manage",
    resource: "workflows:approvals",
    action: "manage",
    description: "Approve or reject workflow approvals",
  },
  {
    name: "workflows:templates:view",
    resource: "workflows:templates",
    action: "view",
    description: "View workflow templates",
  },
  {
    name: "workflows:schedules:manage",
    resource: "workflows:schedules",
    action: "manage",
    description: "Manage workflow schedules",
  },
  {
    name: "workflows:analytics:view",
    resource: "workflows:analytics",
    action: "view",
    description: "View workflow analytics",
  },
  {
    name: "workflows:secrets:manage",
    resource: "workflows:secrets",
    action: "manage",
    description: "Manage workflow secrets",
  },
  {
    name: "workflows:variables:manage",
    resource: "workflows:variables",
    action: "manage",
    description: "Manage workflow variables",
  },
]);
