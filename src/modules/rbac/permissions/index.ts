export type { Permission } from "./types";
export {
  ACCESS_MANAGED_MODULES,
  MODULE_ACCESS_PERMISSIONS,
} from "./module-access";
export { SIGN_PERMISSIONS } from "./sign";
export { NOTIFICATIONS_PERMISSIONS } from "./notifications";
export { HR_PERMISSIONS } from "./hr";
export { CRM_PERMISSIONS } from "./crm";
export { ACCOUNTING_PERMISSIONS } from "./accounting";
export { INVENTORY_PERMISSIONS } from "./inventory";
export { KB_PERMISSIONS } from "./kb";
export { PAYROLL_PERMISSIONS } from "./payroll";
export { BLOG_PERMISSIONS } from "./blog";
export { SALES_PERMISSIONS } from "./sales";
export { SHARED_PERMISSIONS } from "./shared";
export { SUPPORT_PERMISSIONS } from "./support";
export { CHAT_PERMISSIONS } from "./chat";
export { CALENDAR_PERMISSIONS } from "./calendar";
export { API_TOKEN_PERMISSIONS } from "./api-tokens";
export { BILLING_PERMISSIONS } from "./billing";
export { WORKFLOW_PERMISSIONS } from "./workflows";
export { TIMESHEETS_PERMISSIONS } from "./timesheets";
export { ONBOARDING_PERMISSIONS } from "./onboarding";
export { PAYMENTS_PERMISSIONS } from "./payments";
export { SURVEYS_PERMISSIONS } from "./surveys";
export {
  CLIENT_PORTAL_PERMISSIONS,
  QA_BUGS_PERMISSIONS,
  PROJECT_APPROVALS_PERMISSIONS,
  PROJECTS_AI_PERMISSIONS,
  PROJECT_GOVERNANCE_PERMISSIONS,
  PROJECT_MEETINGS_PERMISSIONS,
  PROJECT_INCIDENTS_PERMISSIONS,
  PROJECT_FORMS_PERMISSIONS,
  PROJECT_PORTFOLIO_PERMISSIONS,
  PROJECT_MANAGED_PRODUCTS_PERMISSIONS,
  PROJECT_WORKSPACES_PERMISSIONS,
  PROJECT_TEAMS_PERMISSIONS,
  PROJECT_MEMBERS_PERMISSIONS,
  PROJECT_CUSTOMERS_PERMISSIONS,
  PROJECT_WORKFLOW_PERMISSIONS,
} from "./build";
export { FEEDBUCKET_PERMISSIONS } from "./feedbucket";
export { AI_SUMMARIES_PERMISSIONS, AI_USAGE_PERMISSIONS, EXECUTIVE_BRIEF_PERMISSIONS } from "./ai";
export { DIRECTORY_PERMISSIONS } from "./directory";
export { PARTY_PERMISSIONS } from "./party";
export { MAIL_PERMISSIONS } from "./mail";
export { STORAGE_PERMISSIONS } from "./storage";
export {
  PERMISSIONS,
  ALL_PERMISSION_NAMES,
  moduleScopedPermissions,
} from "./catalog";
export {
  ALL_ROLES,
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSION_GRANTS,
  UNIVERSAL_MEMBER_PERMISSIONS,
} from "./role-defaults";

import { PERMISSIONS } from "./catalog";

const SCOPABLE_PERMISSIONS = new Set(
  PERMISSIONS.filter((p) => p.scopable).map((p) => p.name),
);

export function isScopable(key: string): boolean {
  return SCOPABLE_PERMISSIONS.has(key);
}
