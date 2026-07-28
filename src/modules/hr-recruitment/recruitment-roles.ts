import { ROLE_SLUG } from "../../common/rbac/role-slugs";

export const RECRUITMENT_MANAGER_ROLES: readonly string[] = [
  ROLE_SLUG.CEO,
  ROLE_SLUG.HR,
  ROLE_SLUG.ADMIN,
  ROLE_SLUG.HR_ADMIN,
];

export const RECRUITMENT_RECRUITER_ROLES: readonly string[] = [
  ROLE_SLUG.CEO,
  ROLE_SLUG.HR,
  ROLE_SLUG.ADMIN,
  ROLE_SLUG.HR_ADMIN,
  ROLE_SLUG.RECRUITER,
];
