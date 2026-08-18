import { ALL_PERMISSION_NAMES } from "./catalog";

export const UNIVERSAL_MEMBER_PERMISSION_GRANTS = [
  { permissionKey: "self:onboarding-docs", scope: "own" },
  { permissionKey: "self:onboarding-tasks", scope: "own" },
  { permissionKey: "kb:articles:view", scope: "all" },
  { permissionKey: "kb:spaces:view", scope: "all" },
  { permissionKey: "kb:pages:view", scope: "all" },
] as const;

export const UNIVERSAL_MEMBER_PERMISSIONS = Object.freeze(
  UNIVERSAL_MEMBER_PERMISSION_GRANTS.map(
    ({ permissionKey }) => permissionKey,
  ),
);

const EMPLOYEE_SELF_SERVICE = [
  "branch:view",
  "ownership:transfer:respond",
  "self:attendance",
  "self:leaves",
  "self:expenses",
  "self:payslips",
  "self:payroll",
  ...UNIVERSAL_MEMBER_PERMISSIONS,
  "self:recruitment",
  "self:cases",
  "hr:leaves:create",
  "hr:expenses:create",
  "hr:expenses:view",
  "hr:expenses:read",
  "hr:travel:view",
  "hr:travel:create",
  "chat:channels:read",
  "chat:channels:write",
  "chat:messages:read",
  "chat:messages:write",
  "ai:chat:use",
  "ai:feedback:create",
  "ai:summaries:view",
  "ai:summaries:create",
  "settings:api-tokens:read",
  "settings:api-tokens:write",
  "calendar:read",
  "calendar:write",
  "calendar:ai:use",
  "mail:inbox:view",
  "mail:messages:send",
  "mail:messages:manage",
  "mail:ai:use",
  "integrations:connections:view",
  "integrations:connections:manage",
  "onboarding:module-checklists:view",
  "onboarding:tours:view",
  "timesheets:entries:view",
  "timesheets:entries:create",
  "timesheets:entries:update",
  "tasks:read",
  "directory:people:view",
];

export const ROLE_DEFAULT_PERMISSIONS: Record<string, string[]> = {
  OWNER: ALL_PERMISSION_NAMES,
  ORG_ADMIN: ALL_PERMISSION_NAMES,
  MEMBER: [...EMPLOYEE_SELF_SERVICE],
};

export const ALL_ROLES: readonly string[] = Object.keys(
  ROLE_DEFAULT_PERMISSIONS,
);
