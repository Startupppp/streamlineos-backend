import { definePermissions } from "./types";

export const SHARED_PERMISSIONS = definePermissions([
  {
    name: "tasks:read",
    resource: "tasks",
    action: "read",
    description: "View tasks, sequences, analytics, and queue",
  },
  {
    name: "tasks:write",
    resource: "tasks",
    action: "write",
    description: "Create, update, delete, and complete tasks and sequences",
  },
  {
    name: "accounting:view",
    resource: "accounting",
    action: "view",
    description:
      "View chart of accounts, journal entries, and accounting reports",
  },
  {
    name: "accounting:manage",
    resource: "accounting",
    action: "manage",
    description: "Create and edit accounts and post manual journal entries",
  },
  {
    name: "accounting:report",
    resource: "accounting",
    action: "report",
    description: "Generate Trial Balance, P&L, and other accounting reports",
  },
  {
    name: "build:view",
    resource: "projects",
    action: "view",
    description: "View projects",
  },
  {
    name: "build:create",
    resource: "projects",
    action: "create",
    description: "Create projects",
  },
  {
    name: "build:update",
    resource: "projects",
    action: "update",
    description: "Update projects",
  },
  {
    name: "build:delete",
    resource: "projects",
    action: "delete",
    description: "Delete projects",
  },
  {
    name: "build:manage",
    resource: "projects",
    action: "manage",
    description:
      "Full project management (owner/admin: see and edit all projects)",
    scopable: true,
  },
  {
    name: "build:tickets:view",
    resource: "build:tickets",
    action: "view",
    description: "View tickets",
  },
  {
    name: "build:tickets:create",
    resource: "build:tickets",
    action: "create",
    description: "Create tickets",
  },
  {
    name: "build:tickets:update",
    resource: "build:tickets",
    action: "update",
    description: "Update tickets",
  },
  {
    name: "build:tickets:delete",
    resource: "build:tickets",
    action: "delete",
    description: "Delete tickets",
  },
  {
    name: "build:tickets:assign",
    resource: "build:tickets",
    action: "assign",
    description: "Assign tickets",
  },
  {
    name: "build:cycles:view",
    resource: "build:cycles",
    action: "view",
    description: "View cycles",
  },
  {
    name: "build:cycles:manage",
    resource: "build:cycles",
    action: "manage",
    description: "Manage cycles",
  },
  {
    name: "build:timesheets:view",
    resource: "build:timesheets",
    action: "view",
    description: "View timesheets",
  },
  {
    name: "build:timesheets:create",
    resource: "build:timesheets",
    action: "create",
    description: "Create timesheet entries",
  },
  {
    name: "build:timesheets:manage",
    resource: "build:timesheets",
    action: "manage",
    description: "Manage all timesheets (owner/admin: see and edit everyone's)",
    scopable: true,
  },
  {
    name: "build:goals:view",
    resource: "build:goals",
    action: "view",
    description: "View goals and OKRs",
  },
  {
    name: "build:goals:manage",
    resource: "build:goals",
    action: "manage",
    description: "Create, update, and check in on goals and OKRs",
  },
  {
    name: "build:roadmap:view",
    resource: "build:roadmap",
    action: "view",
    description: "View the product roadmap, feedback, and changelog",
  },
  {
    name: "build:roadmap:manage",
    resource: "build:roadmap",
    action: "manage",
    description: "Manage roadmap items, feedback, and changelog entries",
  },
  {
    name: "build:roadmap:restore",
    resource: "build:roadmap",
    action: "restore",
    description: "Restore soft-deleted roadmap items and feedback posts",
  },
  {
    name: "build:releases:restore",
    resource: "build:releases",
    action: "restore",
    description: "Restore soft-deleted project releases",
  },
  {
    name: "build:whiteboards:manage",
    resource: "build:whiteboards",
    action: "manage",
    description: "Create, edit, share and delete project whiteboards",
  },
  {
    name: "build:whiteboards:restore",
    resource: "build:whiteboards",
    action: "restore",
    description: "Restore soft-deleted project whiteboards",
  },
  {
    name: "build:workspace:manage",
    resource: "build:workspace",
    action: "manage",
    description: "Manage project milestones, views, pages and intake requests",
  },
  {
    name: "build:workspace:restore",
    resource: "build:workspace",
    action: "restore",
    description: "Restore soft-deleted project milestones",
  },
  {
    name: "reports:view",
    resource: "reports",
    action: "view",
    description: "View reports",
  },
  {
    name: "reports:create",
    resource: "reports",
    action: "create",
    description: "Create reports",
  },
  {
    name: "reports:export",
    resource: "reports",
    action: "export",
    description: "Export reports",
  },
  {
    name: "reports:generate",
    resource: "reports",
    action: "generate",
    description: "Generate reports",
  },
  {
    name: "reports:schedule",
    resource: "reports",
    action: "schedule",
    description: "Schedule reports",
  },
  {
    name: "settings:view",
    resource: "settings",
    action: "view",
    description: "View settings",
  },
  {
    name: "settings:manage",
    resource: "settings",
    action: "manage",
    description: "Manage settings",
  },
  {
    name: "settings:mfa",
    resource: "settings",
    action: "mfa",
    description: "Manage MFA settings for the organization",
  },
  {
    name: "settings:rbac:manage",
    resource: "settings:rbac",
    action: "manage",
    description: "Manage RBAC permissions",
  },
  {
    name: "settings:impersonate:manage",
    resource: "settings:impersonate",
    action: "manage",
    description: "Log in as another organization member to troubleshoot their access",
  },
  {
    name: "settings:automations:view",
    resource: "settings:automations",
    action: "view",
    description: "View automation rules and run history",
  },
  {
    name: "settings:automations:manage",
    resource: "settings:automations",
    action: "manage",
    description: "Create, edit, and run automation rules",
  },
  {
    name: "settings:custom-fields:view",
    resource: "settings:custom-fields",
    action: "view",
    description: "View custom field definitions",
  },
  {
    name: "settings:custom-fields:manage",
    resource: "settings:custom-fields",
    action: "manage",
    description: "Manage custom fields",
  },
  {
    /**
     * Arranging a record type is administration; reading the arrangement is not.
     *
     * `GET /renderer/layouts/:layoutKey` carries no key at all, deliberately: an
     * arrangement holds only field names the description already publishes, and
     * every user has to read their tenant's in order to render a list, a detail
     * view or a form at all. Gating the read would make an unprivileged user's
     * screens differ from a privileged one's, which is the opposite of the
     * point. Changing it is what this key buys.
     *
     * It grants nothing about the records themselves. Hiding a field is display
     * only — the value keeps arriving and keeps being stored — so this key can
     * neither widen nor narrow what anybody may read.
     */
    name: "settings:record-layouts:manage",
    resource: "settings:record-layouts",
    action: "manage",
    description:
      "Arrange which fields a record type shows, in what order, and under which headings",
  },
  {
    name: "settings:email-templates:manage",
    resource: "settings:email-templates",
    action: "manage",
    description: "Manage email templates",
  },
  {
    name: "settings:onboarding:manage",
    resource: "settings:onboarding",
    action: "manage",
    description: "Manage onboarding settings",
  },
  {
    name: "settings:webhooks:manage",
    resource: "settings:webhooks",
    action: "manage",
    description: "Manage webhooks",
  },
  {
    name: "settings:organization:manage",
    resource: "settings:organization",
    action: "manage",
    description: "Manage members, invitations, and organization structure",
    scopable: false,
  },
  {
    name: "audit-log:read",
    resource: "audit-log",
    action: "read",
    description: "View the audit log",
  },
  {
    name: "integrations:connections:view",
    resource: "integrations:connections",
    action: "view",
    description: "View connected external app accounts",
  },
  {
    name: "integrations:connections:manage",
    resource: "integrations:connections",
    action: "manage",
    description: "Connect and manage external app accounts",
  },
  /*
   * Repository connections are org-wide and carry a webhook secret, so they get
   * their own pair rather than reusing `integrations:connections:*` — that pair
   * is in `EMPLOYEE_SELF_SERVICE`, held by every MEMBER, because it governs a
   * person connecting their *own* external accounts. Gating a repository
   * connection on it would hand every member the org's git integration, which
   * is the same defect `/settings/api-keys` carried against
   * `settings:api-tokens:*`.
   */
  {
    name: "integrations:git:view",
    resource: "integrations:git",
    action: "view",
    description: "View repository connections and their webhook targets",
  },
  {
    name: "integrations:git:manage",
    resource: "integrations:git",
    action: "manage",
    description: "Connect, edit and remove repository connections",
  },
  {
    name: "dashboard:sales:view",
    resource: "dashboard:sales",
    action: "view",
    description: "View Sales dashboard",
  },
  {
    name: "dashboard:customer-executive:view",
    resource: "dashboard:customer-executive",
    action: "view",
    description: "View Customer Executive dashboard",
  },
  {
    name: "dashboard:support:view",
    resource: "dashboard:support",
    action: "view",
    description: "View Support CRM dashboard",
  },
  {
    name: "self:attendance",
    resource: "self",
    action: "attendance",
    description: "Check in/out own attendance",
  },
  {
    name: "self:leaves",
    resource: "self",
    action: "leaves",
    description: "Submit and view own leave requests",
  },
  {
    name: "self:expenses",
    resource: "self",
    action: "expenses",
    description: "Submit and view own expense claims",
  },
  {
    name: "self:payslips",
    resource: "self",
    action: "payslips",
    description: "View own payslips",
  },
  {
    name: "self:payroll",
    resource: "self",
    action: "payroll",
    description:
      "Access the ESS payroll portal (salary breakdown, declarations, loan requests, bank details)",
  },
  {
    name: "self:onboarding-docs",
    resource: "self",
    action: "onboarding-docs",
    description: "Upload and view own onboarding documents",
  },
  {
    name: "self:onboarding-tasks",
    resource: "self",
    action: "onboarding-tasks",
    description: "View and complete own onboarding tasks",
  },
  {
    name: "self:document-acknowledgements",
    resource: "self",
    action: "document-acknowledgements",
    description: "View and acknowledge documents assigned to oneself",
  },
  {
    name: "self:recruitment",
    resource: "self",
    action: "recruitment",
    description: "View assigned interviews and submit own hiring feedback",
  },
  {
    name: "self:job-openings",
    resource: "self",
    action: "job-openings",
    description: "Browse internal job openings and apply to them",
  },
  {
    name: "self:referrals",
    resource: "self",
    action: "referrals",
    description: "Submit candidate referrals and track own referrals",
  },
  {
    name: "self:cases",
    resource: "self",
    action: "cases",
    description: "View and acknowledge disciplinary actions issued to oneself",
  },
  {
    name: "self:support",
    resource: "self",
    action: "support",
    description: "Raise employee support requests and follow own requests",
  },
  {
    name: "branch:view",
    resource: "branch",
    action: "view",
    description: "View branches",
  },
  {
    name: "branch:create",
    resource: "branch",
    action: "create",
    description: "Create branches",
  },
  {
    name: "branch:update",
    resource: "branch",
    action: "update",
    description: "Update branches",
  },
  {
    name: "branch:delete",
    resource: "branch",
    action: "delete",
    description: "Delete branches",
  },
  {
    name: "ownership:modules:view",
    resource: "ownership:modules",
    action: "view",
    description: "View module ownership assignments and transfer history",
  },
  {
    name: "ownership:modules:manage",
    resource: "ownership:modules",
    action: "manage",
    description: "Initiate, cancel or force-set module ownership transfers",
  },
  {
    name: "ownership:org:transfer",
    resource: "ownership:org",
    action: "transfer",
    description: "Initiate an organization ownership transfer handshake",
  },
  {
    name: "ownership:transfer:respond",
    resource: "ownership:transfer",
    action: "respond",
    description: "Accept or decline an ownership transfer directed at you",
  },
]);
