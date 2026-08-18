import {
  check,
  column as c,
  foreignKey,
  index as i,
  key,
  triggerFunction as f,
  type FileDefinitionRequirement,
} from "./bundle-definition-types";
import {
  columns0004,
  exactColumnRelations0004,
} from "./bundle-columns-0004";

export const definitions0004: FileDefinitionRequirement = {
  columns: [
    ...columns0004,
    c("org_units", "row_version", "integer", true, "1"),
    c("org_units", "archived_at", "timestamp with time zone"),
    c("org_units", "archived_by_membership_id", "integer"),
    c("org_units", "updated_by_membership_id", "integer"),
  ],
  exactColumnRelations: exactColumnRelations0004,
  ownerOnlyRelations: ["app.hrms_partition_operations"],
  constraints: [
    key("app.hrms_partition_operations", "pk_hrms_partition_operations", "primary", ["operation_id"]),
    key("app.hrms_partition_operations", "uniq_hrms_partition_operations_manifest_child", "unique", ["manifest_hash", "parent_table", "child_table"]),
    check(
      "app.hrms_partition_operations",
      "chk_hrms_partition_operations_identity",
      "char_length(operation_id) BETWEEN 3 AND 512 " +
      "AND operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$' " +
      "AND char_length(approval_id) BETWEEN 3 AND 128 " +
      "AND approval_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' " +
      "AND char_length(base_bundle_id) BETWEEN 3 AND 128 " +
      "AND base_bundle_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$' " +
      "AND root_migration_name = '0398_backfill_hr_admin_branch_hr_recruitment_grants.sql' " +
      "AND char_length(database_name) BETWEEN 1 AND 128 " +
      "AND database_name ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]*$' " +
      "AND database_role ~ '^[A-Za-z_][A-Za-z0-9_$-]{0,62}$' " +
      "AND parent_table ~ '^[a-z][a-z0-9_]{0,62}$' " +
      "AND child_table ~ '^[a-z][a-z0-9_]{0,62}$' " +
      "AND server_version_num > 0",
    ),
    check(
      "app.hrms_partition_operations",
      "chk_hrms_partition_operations_hashes",
      "manifest_hash ~ '^[0-9a-f]{64}$' " +
      "AND root_migration_hash ~ '^[0-9a-f]{64}$' " +
      "AND base_dependencies_hash ~ '^[0-9a-f]{64}$' " +
      "AND ddl_hash ~ '^[0-9a-f]{64}$'",
    ),
    check(
      "app.hrms_partition_operations",
      "chk_hrms_partition_operations_partition",
      "( partition_kind = 'RANGE' " +
      "AND parent_table IN ('attendance_events', 'attendance_event_evidence', 'worker_leave_ledger_entries', 'hr_audit_events') " +
      "AND range_from IS NOT NULL AND range_to IS NOT NULL " +
      "AND range_from >= DATE '0001-01-01' AND range_from <= DATE '9999-12-01' " +
      "AND extract(day FROM range_from) = 1 " +
      "AND range_to = (range_from + interval '1 month')::date " +
      "AND hash_modulus IS NULL AND hash_remainder IS NULL " +
      "AND child_table = parent_table || '_y' || lpad(extract(year FROM range_from)::integer::text, 4, '0') || 'm' || lpad(extract(month FROM range_from)::integer::text, 2, '0') ) " +
      "OR ( partition_kind = 'HASH' " +
      "AND parent_table IN ('attendance_event_locators', 'attendance_correction_links', 'hr_audit_event_sources', 'worker_leave_entry_locators', 'worker_leave_reversal_links') " +
      "AND range_from IS NULL AND range_to IS NULL " +
      "AND hash_modulus = 16 AND hash_remainder BETWEEN 0 AND 15 " +
      "AND child_table = parent_table || '_h' || lpad(hash_remainder::text, 2, '0') )",
    ),
    check("app.hrms_partition_operations", "chk_hrms_partition_operations_security_profile", "security_profile = 'base-owner-only-v1'"),
    check("app.hrms_partition_operations", "chk_hrms_partition_operations_state", "state IN ('RUNNING', 'VERIFYING', 'COMPLETE', 'FAILED')"),
    check("app.hrms_partition_operations", "chk_hrms_partition_operations_attempts", "attempts > 0"),
    check("app.hrms_partition_operations", "chk_hrms_partition_operations_error", "last_error IS NULL OR last_error ~ '^[A-Z][A-Z0-9_.:-]{0,255}$'"),
    check("app.hrms_partition_operations", "chk_hrms_partition_operations_timestamps", "completed_at IS NULL OR completed_at >= started_at"),
    check(
      "app.hrms_partition_operations",
      "chk_hrms_partition_operations_state_shape",
      "(state IN ('RUNNING', 'VERIFYING') AND completed_at IS NULL AND last_error IS NULL) " +
      "OR (state = 'COMPLETE' AND completed_at IS NOT NULL AND last_error IS NULL) " +
      "OR (state = 'FAILED' AND completed_at IS NOT NULL AND last_error IS NOT NULL)",
    ),
    key("org_unit_closure", "pk_org_unit_closure", "primary", ["organization_id", "ancestor_id", "descendant_id"]),
    foreignKey("org_unit_closure", "fk_org_unit_closure_ancestor_tenant", ["organization_id", "ancestor_id"], "org_units", ["org_id", "id"], { deleteAction: "c" }),
    foreignKey("org_unit_closure", "fk_org_unit_closure_descendant_tenant", ["organization_id", "descendant_id"], "org_units", ["org_id", "id"], { deleteAction: "c" }),
    check("org_unit_closure", "chk_org_unit_closure_depth", "(ancestor_id = descendant_id AND depth = 0) OR (ancestor_id <> descendant_id AND depth > 0)"),
    key("hr_audit_event_sources", "pk_hr_audit_event_sources", "primary", ["organization_id", "audit_event_id"]),
    key("hr_audit_event_sources", "uniq_hr_audit_event_sources_event_time", "unique", ["organization_id", "audit_event_id", "occurred_at"]),
    key("hr_audit_event_sources", "uniq_hr_audit_event_sources_source", "unique", ["organization_id", "source_type", "source_id", "source_ordinal"]),
    foreignKey("hr_audit_event_sources", "fk_hr_audit_event_sources_organization", ["organization_id"], "organizations", ["id"]),
    check("hr_audit_event_sources", "chk_hr_audit_event_sources_key", "btrim(source_type) <> '' AND btrim(source_id) <> '' AND source_ordinal >= 0"),
    key("hr_audit_events", "pk_hr_audit_events", "primary", ["organization_id", "occurred_at", "audit_event_id"]),
    key("hr_audit_events", "uniq_hr_audit_events_source", "unique", ["organization_id", "occurred_at", "source_type", "source_id", "source_ordinal"]),
    foreignKey("hr_audit_events", "fk_hr_audit_events_organization", ["organization_id"], "organizations", ["id"]),
    foreignKey("hr_audit_events", "fk_hr_audit_events_source", ["organization_id", "audit_event_id", "occurred_at"], "hr_audit_event_sources", ["organization_id", "audit_event_id", "occurred_at"], { deferrable: true }),
    check("hr_audit_events", "chk_hr_audit_events_source_ordinal_nonnegative", "source_ordinal >= 0"),
    check("hr_audit_events", "chk_hr_audit_events_required_text", "btrim(entity_type) <> '' AND btrim(entity_id) <> '' AND btrim(action) <> '' AND btrim(source_type) <> '' AND btrim(source_id) <> ''"),
    check("hr_audit_events", "chk_hr_audit_events_optional_text", "(request_id IS NULL OR btrim(request_id) <> '') AND (correlation_id IS NULL OR btrim(correlation_id) <> '') AND (migration_batch_id IS NULL OR btrim(migration_batch_id) <> '')"),
    check("hr_audit_events", "chk_hr_audit_events_redacted_diff_object", "jsonb_typeof(redacted_diff) = 'object'"),
    check("org_units", "chk_org_units_row_version_positive", "row_version > 0", false),
    check("org_units", "chk_org_units_kind", "kind IN ( 'BUSINESS_UNIT', 'BRANCH', 'DEPARTMENT', 'TEAM', 'LOCATION', 'COST_CENTER' )", false),
    check("org_units", "chk_org_units_status", "status IN ('ACTIVE', 'DISABLED', 'ARCHIVED')", false),
    check("org_units", "chk_org_units_parent_not_self", "parent_id IS NULL OR parent_id <> id", false),
    foreignKey("org_units", "fk_org_units_parent_tenant", ["org_id", "parent_id"], "org_units", ["org_id", "id"], { validated: false }),
    foreignKey("org_units", "fk_org_units_archived_by_membership", ["org_id", "archived_by_membership_id"], "organization_members", ["org_id", "id"], { validated: false }),
    foreignKey("org_units", "fk_org_units_updated_by_membership", ["org_id", "updated_by_membership_id"], "organization_members", ["org_id", "id"], { validated: false }),
    foreignKey("hr_audit_event_sources", "fk_hr_audit_event_sources_fact", ["organization_id", "occurred_at", "audit_event_id"], "hr_audit_events", ["organization_id", "occurred_at", "audit_event_id"], { deferrable: true }),
  ],
  indexes: [
    i("org_unit_closure", "idx_org_unit_closure_descendant_scope", ["organization_id", "descendant_id", "depth", "ancestor_id"]),
    i("hr_audit_event_sources", "idx_hr_audit_event_sources_org_time", ["organization_id", "occurred_at"]),
    i("hr_audit_events", "idx_hr_audit_events_org_entity_time", ["organization_id", "entity_type", "entity_id", "occurred_at"]),
    i("hr_audit_events", "idx_hr_audit_events_org_actor_time", ["organization_id", "actor_membership_id", "occurred_at"]),
    i("hr_audit_events", "idx_hr_audit_events_org_correlation", ["organization_id", "correlation_id"]),
  ],
  functions: [
    f("enforce_hrms_partition_operation_transition", false, false),
    f("verify_org_unit_parent_cycle", true, false),
    f("verify_hr_audit_source_fact", true),
  ],
  enums: [],
};
