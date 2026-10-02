import { definePermissions } from "./types";

export const SURVEYS_PERMISSIONS = definePermissions([
  {
    name: "surveys:view",
    resource: "surveys",
    action: "view",
    description:
      "View surveys, assessments, live sessions, and lead qualification forms",
    scopable: true,
  },
  {
    name: "surveys:create",
    resource: "surveys",
    action: "create",
    description: "Create surveys",
  },
  {
    name: "surveys:update",
    resource: "surveys",
    action: "update",
    description: "Edit survey builder content",
    scopable: true,
  },
  {
    name: "surveys:publish",
    resource: "surveys",
    action: "publish",
    description: "Publish, pause, and close surveys",
    scopable: true,
  },
  {
    name: "surveys:delete",
    resource: "surveys",
    action: "delete",
    description: "Delete or archive surveys",
    scopable: true,
  },
  {
    name: "surveys:participants:view",
    resource: "surveys:participants",
    action: "view",
    description: "View survey participants and collectors",
  },
  {
    name: "surveys:participants:manage",
    resource: "surveys:participants",
    action: "manage",
    description: "Import, invite, and remind survey participants",
  },
  {
    name: "surveys:responses:view",
    resource: "surveys:responses",
    action: "view",
    description: "View survey responses",
  },
  {
    name: "surveys:ai:use",
    resource: "surveys:ai",
    action: "use",
    description: "Use AI assist on surveys (summarize responses)",
  },
  {
    name: "surveys:responses:export",
    resource: "surveys:responses",
    action: "export",
    description: "Export survey responses",
  },
  {
    name: "surveys:analytics:view",
    resource: "surveys:analytics",
    action: "view",
    description: "View survey analytics and reports",
  },
  {
    name: "surveys:live:host",
    resource: "surveys:live",
    action: "host",
    description: "Host live survey sessions",
  },
  {
    name: "surveys:assessments:manage",
    resource: "surveys:assessments",
    action: "manage",
    description: "Manage assessment scoring, attempts, and certificates",
  },
  {
    name: "surveys:automations:manage",
    resource: "surveys:automations",
    action: "manage",
    description: "Manage survey automations and lead routing rules",
  },
]);
