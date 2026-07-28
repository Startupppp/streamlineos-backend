import { ROLE_SLUG } from "../../common/rbac/role-slugs";

export const HR_ADMIN_ROLES = [
  ROLE_SLUG.CEO,
  ROLE_SLUG.HR,
  ROLE_SLUG.ADMIN,
  ROLE_SLUG.BRANCH_HR,
  ROLE_SLUG.BRANCH_MANAGER,
] as const;

export const HR_NOTIFY_ROLES = [ROLE_SLUG.CEO, ROLE_SLUG.HR] as const;

export const CEO_ROLES = [ROLE_SLUG.CEO] as const;

export const WEEKLY_RECAP_RECIPIENT_ROLES = [ROLE_SLUG.CEO] as const;
