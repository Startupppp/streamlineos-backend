import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizationMembers, organizations, users } from "../common/auth";
import { organizationPeople } from "../directory/organization-people";
import { workerEngagements } from "../directory/worker-engagements";
import { workers } from "../directory/workers";
import { hrEmployments, hrPeople } from "./core-people";

type ReconciliationIssueKind =
  | "CLASSIFICATION"
  | "IDENTITY_CONFLICT"
  | "FIELD_MISMATCH"
  | "PII_ATTRIBUTION";
type ReconciliationStatus = "OPEN" | "PREPARED" | "APPROVED";
type WorkforceClassification =
  | "ACCESS_ONLY"
  | "PERSON_ONLY"
  | "WORKFORCE_SUBJECT"
  | "LEGACY_COMPATIBILITY_SUBJECT";

export const hrWorkforceReconciliationItems = pgTable(
  "hr_workforce_reconciliation_items",
  {
    reconciliationItemId: bigint("reconciliation_item_id", { mode: "bigint" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "restrict" })
      .notNull(),
    batchId: text("batch_id").notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    issueKind: text("issue_kind").$type<ReconciliationIssueKind>().notNull(),
    fieldCode: text("field_code"),
    status: text("status").$type<ReconciliationStatus>().default("OPEN").notNull(),
    sourceMembershipId: integer("source_membership_id"),
    sourceUserId: text("source_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    sourceOrganizationPersonId: text("source_organization_person_id"),
    sourceWorkerId: text("source_worker_id"),
    sourceWorkerEngagementId: text("source_worker_engagement_id"),
    sourceHrPersonId: integer("source_hr_person_id"),
    sourceHrEmploymentId: integer("source_hr_employment_id"),
    resolvedOrganizationPersonId: text("resolved_organization_person_id"),
    resolvedWorkerId: text("resolved_worker_id"),
    resolvedWorkerEngagementId: text("resolved_worker_engagement_id"),
    classification: text("classification").$type<WorkforceClassification>(),
    reasonCode: text("reason_code"),
    sourceSnapshotHash: text("source_snapshot_hash").notNull(),
    resolutionHash: text("resolution_hash"),
    manifestHash: text("manifest_hash"),
    preparedByMembershipId: integer("prepared_by_membership_id"),
    preparedAt: timestamp("prepared_at", { withTimezone: true }),
    approvedByMembershipId: integer("approved_by_membership_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rowVersion: integer("row_version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_hr_workforce_reconciliation_org_id").on(
      table.orgId,
      table.reconciliationItemId,
    ),
    uniqueIndex("uniq_hr_workforce_reconciliation_source").on(
      table.orgId,
      table.batchId,
      table.sourceFingerprint,
      table.issueKind,
      sql`coalesce(${table.fieldCode}, '')`,
    ),
    index("idx_hr_workforce_reconciliation_status").on(
      table.orgId,
      table.batchId,
      table.status,
    ),
    index("idx_hr_workforce_reconciliation_resolved_worker").on(
      table.orgId,
      table.resolvedWorkerId,
    ),
    index("idx_hr_workforce_reconciliation_prepared_actor").on(
      table.orgId,
      table.preparedByMembershipId,
    ),
    index("idx_hr_workforce_reconciliation_approved_actor").on(
      table.orgId,
      table.approvedByMembershipId,
    ),
    foreignKey({
      columns: [table.orgId, table.sourceMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_hr_workforce_reconciliation_source_membership",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.sourceOrganizationPersonId],
      foreignColumns: [
        organizationPeople.organizationId,
        organizationPeople.organizationPersonId,
      ],
      name: "fk_hr_workforce_reconciliation_source_person",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.sourceOrganizationPersonId, table.sourceWorkerId],
      foreignColumns: [
        workers.organizationId,
        workers.organizationPersonId,
        workers.workerId,
      ],
      name: "fk_hr_workforce_reconciliation_source_worker",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.sourceWorkerId, table.sourceWorkerEngagementId],
      foreignColumns: [
        workerEngagements.organizationId,
        workerEngagements.workerId,
        workerEngagements.workerEngagementId,
      ],
      name: "fk_hr_workforce_reconciliation_source_engagement",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.sourceHrPersonId],
      foreignColumns: [hrPeople.orgId, hrPeople.id],
      name: "fk_hr_workforce_reconciliation_source_hr_person",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.sourceHrEmploymentId, table.sourceHrPersonId],
      foreignColumns: [hrEmployments.orgId, hrEmployments.id, hrEmployments.personId],
      name: "fk_hr_workforce_reconciliation_source_hr_employment",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.resolvedOrganizationPersonId],
      foreignColumns: [
        organizationPeople.organizationId,
        organizationPeople.organizationPersonId,
      ],
      name: "fk_hr_workforce_reconciliation_resolved_person",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.orgId,
        table.resolvedOrganizationPersonId,
        table.resolvedWorkerId,
      ],
      foreignColumns: [
        workers.organizationId,
        workers.organizationPersonId,
        workers.workerId,
      ],
      name: "fk_hr_workforce_reconciliation_resolved_worker",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.resolvedWorkerId, table.resolvedWorkerEngagementId],
      foreignColumns: [
        workerEngagements.organizationId,
        workerEngagements.workerId,
        workerEngagements.workerEngagementId,
      ],
      name: "fk_hr_workforce_reconciliation_resolved_engagement",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.preparedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_hr_workforce_reconciliation_prepared_actor",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.approvedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_hr_workforce_reconciliation_approved_actor",
    }).onDelete("restrict"),
    check(
      "chk_hr_workforce_reconciliation_status",
      sql`${table.status} IN ('OPEN', 'PREPARED', 'APPROVED')`,
    ),
    check(
      "chk_hr_workforce_reconciliation_issue_kind",
      sql`${table.issueKind} IN ('CLASSIFICATION', 'IDENTITY_CONFLICT', 'FIELD_MISMATCH', 'PII_ATTRIBUTION')`,
    ),
    check(
      "chk_hr_workforce_reconciliation_classification",
      sql`${table.classification} IS NULL OR ${table.classification} IN ('ACCESS_ONLY', 'PERSON_ONLY', 'WORKFORCE_SUBJECT', 'LEGACY_COMPATIBILITY_SUBJECT')`,
    ),
    check(
      "chk_hr_workforce_reconciliation_nonblank_source",
      sql`btrim(${table.batchId}) <> '' AND btrim(${table.sourceFingerprint}) <> '' AND btrim(${table.sourceSnapshotHash}) <> '' AND (${table.fieldCode} IS NULL OR btrim(${table.fieldCode}) <> '')`,
    ),
    check(
      "chk_hr_workforce_reconciliation_nonblank_resolution",
      sql`(${table.reasonCode} IS NULL OR btrim(${table.reasonCode}) <> '') AND (${table.resolutionHash} IS NULL OR btrim(${table.resolutionHash}) <> '') AND (${table.manifestHash} IS NULL OR btrim(${table.manifestHash}) <> '')`,
    ),
    check(
      "chk_hr_workforce_reconciliation_has_source",
      sql`num_nonnulls(${table.sourceMembershipId}, ${table.sourceUserId}, ${table.sourceOrganizationPersonId}, ${table.sourceHrPersonId}) > 0`,
    ),
    check(
      "chk_hr_workforce_reconciliation_source_chain",
      sql`(${table.sourceWorkerId} IS NULL OR ${table.sourceOrganizationPersonId} IS NOT NULL) AND (${table.sourceWorkerEngagementId} IS NULL OR ${table.sourceWorkerId} IS NOT NULL) AND (${table.sourceHrEmploymentId} IS NULL OR ${table.sourceHrPersonId} IS NOT NULL)`,
    ),
    check(
      "chk_hr_workforce_reconciliation_resolution_chain",
      sql`(${table.resolvedWorkerId} IS NULL OR ${table.resolvedOrganizationPersonId} IS NOT NULL) AND (${table.resolvedWorkerEngagementId} IS NULL OR ${table.resolvedWorkerId} IS NOT NULL)`,
    ),
    check(
      "chk_hr_workforce_reconciliation_approved_shape",
      sql`${table.status} <> 'APPROVED' OR (${table.classification} = 'ACCESS_ONLY' AND ${table.resolvedOrganizationPersonId} IS NULL AND ${table.resolvedWorkerId} IS NULL AND ${table.resolvedWorkerEngagementId} IS NULL) OR (${table.classification} = 'PERSON_ONLY' AND ${table.resolvedOrganizationPersonId} IS NOT NULL AND ${table.resolvedWorkerId} IS NULL AND ${table.resolvedWorkerEngagementId} IS NULL) OR (${table.classification} IN ('WORKFORCE_SUBJECT', 'LEGACY_COMPATIBILITY_SUBJECT') AND ${table.resolvedOrganizationPersonId} IS NOT NULL AND ${table.resolvedWorkerId} IS NOT NULL AND ${table.resolvedWorkerEngagementId} IS NOT NULL)`,
    ),
    check(
      "chk_hr_workforce_reconciliation_distinct_reviewers",
      sql`${table.preparedByMembershipId} IS NULL OR ${table.approvedByMembershipId} IS NULL OR ${table.preparedByMembershipId} <> ${table.approvedByMembershipId}`,
    ),
    check(
      "chk_hr_workforce_reconciliation_review_state",
      sql`(${table.status} = 'OPEN' AND ${table.classification} IS NULL AND ${table.reasonCode} IS NULL AND ${table.resolutionHash} IS NULL AND ${table.manifestHash} IS NULL AND ${table.preparedByMembershipId} IS NULL AND ${table.preparedAt} IS NULL AND ${table.approvedByMembershipId} IS NULL AND ${table.approvedAt} IS NULL) OR (${table.status} = 'PREPARED' AND ${table.classification} IS NOT NULL AND ${table.reasonCode} IS NOT NULL AND ${table.resolutionHash} IS NOT NULL AND ${table.manifestHash} IS NULL AND ${table.preparedByMembershipId} IS NOT NULL AND ${table.preparedAt} IS NOT NULL AND ${table.approvedByMembershipId} IS NULL AND ${table.approvedAt} IS NULL) OR (${table.status} = 'APPROVED' AND ${table.classification} IS NOT NULL AND ${table.reasonCode} IS NOT NULL AND ${table.resolutionHash} IS NOT NULL AND ${table.manifestHash} IS NOT NULL AND ${table.preparedByMembershipId} IS NOT NULL AND ${table.preparedAt} IS NOT NULL AND ${table.approvedByMembershipId} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)`,
    ),
    check(
      "chk_hr_workforce_reconciliation_row_version",
      sql`${table.rowVersion} > 0`,
    ),
  ],
);
