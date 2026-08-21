import type { BundleFileName } from "./bundle-config";
import { definitions0000 } from "./bundle-definitions-0000";
import { definitions0001 } from "./bundle-definitions-0001";
import { definitions0002 } from "./bundle-definitions-0002";
import { definitions0003 } from "./bundle-definitions-0003";
import { definitions0004 } from "./bundle-definitions-0004";
import type { FileDefinitionRequirement } from "./bundle-definition-types";

export const bundleDefinitionRegistry: Record<
  BundleFileName,
  FileDefinitionRequirement
> = {
  "0000_hrms_profiles_workforce.sql": definitions0000,
  "0001_hrms_effective_history.sql": definitions0001,
  "0002_hrms_leave_ledger.sql": definitions0002,
  "0003_hrms_attendance_events.sql": definitions0003,
  "0004_hrms_hierarchy_audit.sql": definitions0004,
};
