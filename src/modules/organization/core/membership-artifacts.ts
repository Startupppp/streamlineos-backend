import type { MembershipArtifact } from "./membership-artifact.types";
import { ACCESS_AND_MEMBERSHIP_ARTIFACTS } from "./membership-artifact-catalog/access-and-membership.artifacts";
import { BUILD_ARTIFACTS } from "./membership-artifact-catalog/build.artifacts";
import { CHAT_ARTIFACTS } from "./membership-artifact-catalog/chat.artifacts";
import { CRM_AND_SALES_ARTIFACTS } from "./membership-artifact-catalog/crm-and-sales.artifacts";
import { HR_LIFECYCLE_AND_RECORDS_ARTIFACTS } from "./membership-artifact-catalog/hr-lifecycle-and-records.artifacts";
import { HR_PERFORMANCE_AND_ENGAGEMENT_ARTIFACTS } from "./membership-artifact-catalog/hr-performance-and-engagement.artifacts";
import { HR_TIME_AND_ATTENDANCE_ARTIFACTS } from "./membership-artifact-catalog/hr-time-and-attendance.artifacts";
import { HR_WORKFORCE_ARTIFACTS } from "./membership-artifact-catalog/hr-workforce.artifacts";
import { KNOWLEDGE_BASE_ARTIFACTS } from "./membership-artifact-catalog/knowledge-base.artifacts";
import { NON_DATABASE_ARTIFACTS } from "./membership-artifact-catalog/non-database.artifacts";
import { NOTIFICATIONS_ARTIFACTS } from "./membership-artifact-catalog/notifications.artifacts";
import { PAYROLL_AND_EXPENSES_ARTIFACTS } from "./membership-artifact-catalog/payroll-and-expenses.artifacts";
import { PENDING_MIGRATION_ARTIFACTS } from "./membership-artifact-catalog/pending-migration.artifacts";
import { PLATFORM_SERVICES_ARTIFACTS } from "./membership-artifact-catalog/platform-services.artifacts";
import { RECRUITMENT_ARTIFACTS } from "./membership-artifact-catalog/recruitment.artifacts";
import { SUPPORT_ARTIFACTS } from "./membership-artifact-catalog/support.artifacts";
import { TIMESHEETS_ARTIFACTS } from "./membership-artifact-catalog/timesheets.artifacts";

export type { MembershipArtifact, RemovalAction } from "./membership-artifact.types";

export const MEMBERSHIP_ARTIFACTS = [
  ...ACCESS_AND_MEMBERSHIP_ARTIFACTS,
  ...BUILD_ARTIFACTS,
  ...CHAT_ARTIFACTS,
  ...CRM_AND_SALES_ARTIFACTS,
  ...HR_LIFECYCLE_AND_RECORDS_ARTIFACTS,
  ...HR_PERFORMANCE_AND_ENGAGEMENT_ARTIFACTS,
  ...HR_TIME_AND_ATTENDANCE_ARTIFACTS,
  ...HR_WORKFORCE_ARTIFACTS,
  ...KNOWLEDGE_BASE_ARTIFACTS,
  ...NON_DATABASE_ARTIFACTS,
  ...NOTIFICATIONS_ARTIFACTS,
  ...PAYROLL_AND_EXPENSES_ARTIFACTS,
  ...PENDING_MIGRATION_ARTIFACTS,
  ...PLATFORM_SERVICES_ARTIFACTS,
  ...RECRUITMENT_ARTIFACTS,
  ...SUPPORT_ARTIFACTS,
  ...TIMESHEETS_ARTIFACTS,
] as const satisfies readonly MembershipArtifact[];

export const MEMBERSHIP_ARTIFACT_IDS = MEMBERSHIP_ARTIFACTS.map(
  (artifact) => artifact.id,
);

export const MEMBERSHIP_ARTIFACT_TABLES = MEMBERSHIP_ARTIFACTS.filter(
  (artifact) => artifact.table !== null,
).map((artifact) => artifact.table);

export function artifactsRequiringWriteOnRemoval(): readonly MembershipArtifact[] {
  return MEMBERSHIP_ARTIFACTS.filter(
    (artifact) => artifact.onRemoval !== "cascade",
  );
}

export function artifactsRequiringWriteOnSuspension(): readonly MembershipArtifact[] {
  return MEMBERSHIP_ARTIFACTS.filter(
    (artifact) => artifact.onSuspension === "revoke",
  );
}
