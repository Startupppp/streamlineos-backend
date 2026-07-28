import type { Permission } from "./types";

export const CLIENT_PORTAL_PERMISSIONS: Permission[] = [
  {
    name: "build:portal:view",
    resource: "build:portal",
    action: "view",
    description: "Access the client portal",
  },
  {
    name: "build:changerequests:view",
    resource: "build:changerequests",
    action: "view",
    description: "View change requests",
  },
  {
    name: "build:changerequests:create",
    resource: "build:changerequests",
    action: "create",
    description: "Submit new change requests",
  },
  {
    name: "build:changerequests:manage",
    resource: "build:changerequests",
    action: "manage",
    description: "Estimate, approve, reject, and progress change requests",
  },
  {
    name: "build:clientvisibility:manage",
    resource: "build:clientvisibility",
    action: "manage",
    description: "Toggle client-visibility of project items",
  },
];

export const QA_BUGS_PERMISSIONS: Permission[] = [
  {
    name: "build:qa:view",
    resource: "build:qa",
    action: "view",
    description: "View QA test suites, cases, and runs",
  },
  {
    name: "build:qa:manage",
    resource: "build:qa",
    action: "manage",
    description: "Create, edit, and delete QA test suites, cases, and runs",
  },
  {
    name: "build:qa:execute",
    resource: "build:qa",
    action: "execute",
    description: "Record test results in QA test runs",
  },
  {
    name: "build:bugs:view",
    resource: "build:bugs",
    action: "view",
    description: "View bugs",
  },
  {
    name: "build:bugs:create",
    resource: "build:bugs",
    action: "create",
    description: "Report new bugs",
  },
  {
    name: "build:bugs:update",
    resource: "build:bugs",
    action: "update",
    description: "Update bug details and status",
  },
  {
    name: "build:bugs:delete",
    resource: "build:bugs",
    action: "delete",
    description: "Delete bugs",
  },
];

export const PROJECT_APPROVALS_PERMISSIONS: Permission[] = [
  {
    name: "build:approvals:view",
    resource: "build:approvals",
    action: "view",
    description: "View approvals",
  },
  {
    name: "build:approvals:request",
    resource: "build:approvals",
    action: "request",
    description: "Request an approval on an entity",
  },
  {
    name: "build:approvals:decide",
    resource: "build:approvals",
    action: "decide",
    description:
      "Approve/reject/request-changes on approvals assigned to you",
  },
  {
    name: "build:approvals:manage",
    resource: "build:approvals",
    action: "manage",
    description:
      "Cancel/escalate/delegate/reassign approvals (privileged)",
  },
];

export const PROJECTS_AI_PERMISSIONS: Permission[] = [
  {
    name: "build:ai:use",
    resource: "build:ai",
    action: "use",
    description:
      "Use AI features on projects (summary, risks, client update, plan, task extraction, Q&A)",
  },
];

export const PROJECT_MEETINGS_PERMISSIONS: Permission[] = [
  {
    name: "build:meetings:view",
    resource: "build:meetings",
    action: "view",
    description: "View project meetings, standups, and action items",
  },
  {
    name: "build:meetings:manage",
    resource: "build:meetings",
    action: "manage",
    description:
      "Create, update, and delete project meetings and action items",
  },
];

export const PROJECT_INCIDENTS_PERMISSIONS: Permission[] = [
  {
    name: "build:incidents:view",
    resource: "build:incidents",
    action: "view",
    description: "View project incidents and SLA timelines",
  },
  {
    name: "build:incidents:manage",
    resource: "build:incidents",
    action: "manage",
    description: "Create, update, and resolve project incidents",
  },
];

export const PROJECT_FORMS_PERMISSIONS: Permission[] = [
  {
    name: "build:forms:view",
    resource: "build:forms",
    action: "view",
    description: "View project forms and submissions",
  },
  {
    name: "build:forms:manage",
    resource: "build:forms",
    action: "manage",
    description: "Create, update, and delete project forms and submissions",
  },
];

export const PROJECT_TEAMS_PERMISSIONS: Permission[] = [
  {
    name: "build:teams:view",
    resource: "build:teams",
    action: "view",
    description: "View teams and their members",
  },
  {
    name: "build:teams:create",
    resource: "build:teams",
    action: "create",
    description: "Create teams",
  },
  {
    name: "build:teams:update",
    resource: "build:teams",
    action: "update",
    description: "Update team details",
  },
  {
    name: "build:teams:delete",
    resource: "build:teams",
    action: "delete",
    description: "Delete teams",
  },
  {
    name: "build:teams:manage",
    resource: "build:teams",
    action: "manage",
    description: "Add or remove team members",
  },
];

export const PROJECT_MEMBERS_PERMISSIONS: Permission[] = [
  {
    name: "build:members:view",
    resource: "build:members",
    action: "view",
    description: "View workspace members list for project assignment",
    scopable: false,
  },
  {
    name: "build:members:manage",
    resource: "build:members",
    action: "manage",
    description: "Manage workspace members on projects",
    scopable: false,
  },
];

export const PROJECT_CUSTOMERS_PERMISSIONS: Permission[] = [
  {
    name: "build:customers:view",
    resource: "build:customers",
    action: "view",
    description: "View CRM organizations for project customer linking",
    scopable: false,
  },
  {
    name: "build:customers:manage",
    resource: "build:customers",
    action: "manage",
    description: "Manage CRM organization links on projects",
    scopable: false,
  },
];

export const PROJECT_PORTFOLIO_PERMISSIONS: Permission[] = [
  {
    name: "build:portfolios:view",
    resource: "build:portfolios",
    action: "view",
    description: "View portfolios and programs",
  },
  {
    name: "build:portfolios:manage",
    resource: "build:portfolios",
    action: "manage",
    description: "Create, update, and delete portfolios",
  },
  {
    name: "build:programs:view",
    resource: "build:programs",
    action: "view",
    description: "View programs",
  },
  {
    name: "build:programs:manage",
    resource: "build:programs",
    action: "manage",
    description: "Create, update, and delete programs",
  },
];

export const PROJECT_MANAGED_PRODUCTS_PERMISSIONS: Permission[] = [
  {
    name: "build:managed-products:view",
    resource: "build:managed-products",
    action: "view",
    description: "View managed products",
  },
  {
    name: "build:managed-products:create",
    resource: "build:managed-products",
    action: "create",
    description: "Create managed products",
  },
  {
    name: "build:managed-products:update",
    resource: "build:managed-products",
    action: "update",
    description: "Update managed products",
  },
  {
    name: "build:managed-products:delete",
    resource: "build:managed-products",
    action: "delete",
    description: "Delete managed products",
  },
];

export const PROJECT_WORKSPACES_PERMISSIONS: Permission[] = [
  {
    name: "build:workspaces:view",
    resource: "build:workspaces",
    action: "view",
    description: "View PM workspaces",
  },
  {
    name: "build:workspaces:create",
    resource: "build:workspaces",
    action: "create",
    description: "Create PM workspaces",
  },
  {
    name: "build:workspaces:update",
    resource: "build:workspaces",
    action: "update",
    description: "Update PM workspaces",
  },
  {
    name: "build:workspaces:delete",
    resource: "build:workspaces",
    action: "delete",
    description: "Delete PM workspaces",
  },
  {
    name: "build:workspaces:members:view",
    resource: "build:workspaces:members",
    action: "view",
    description: "View PM workspace members",
  },
  {
    name: "build:workspaces:members:manage",
    resource: "build:workspaces:members",
    action: "manage",
    description: "Add and remove PM workspace members",
  },
];

export const PROJECT_WORKFLOW_PERMISSIONS: Permission[] = [
  {
    name: "build:workflow:view",
    resource: "build:workflow",
    action: "view",
    description: "View workflow transition rules and WIP limits",
  },
  {
    name: "build:workflow:manage",
    resource: "build:workflow",
    action: "manage",
    description:
      "Create, update, and delete workflow transition rules and WIP limits",
  },
];

export const PROJECT_GOVERNANCE_PERMISSIONS: Permission[] = [
  {
    name: "build:risks:view",
    resource: "build:risks",
    action: "view",
    description: "View project risks",
  },
  {
    name: "build:risks:manage",
    resource: "build:risks",
    action: "manage",
    description: "Create, update, and delete project risks",
  },
  {
    name: "build:decisions:view",
    resource: "build:decisions",
    action: "view",
    description: "View project decisions",
  },
  {
    name: "build:decisions:manage",
    resource: "build:decisions",
    action: "manage",
    description: "Create, update, and delete project decisions",
  },
];
