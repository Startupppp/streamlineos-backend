import type { Permission } from "./types";
import { HR_ENTERPRISE_PERMISSIONS } from "./hr-enterprise.permissions";
import { HR_FOUNDATION_PERMISSIONS } from "./hr-foundation.permissions";
import { HR_WORKFORCE_PERMISSIONS } from "./hr-workforce.permissions";

export const HR_PERMISSIONS: Permission[] = [
  ...HR_FOUNDATION_PERMISSIONS,
  ...HR_WORKFORCE_PERMISSIONS,
  ...HR_ENTERPRISE_PERMISSIONS,
];
