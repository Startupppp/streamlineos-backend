export type BugColumnTarget =
  | "work_item"
  | "qa_sidecar"
  | "identity_map"
  | "work_item_relation"
  | "drop";

export interface BugColumnDisposition {
  target: BugColumnTarget;
  destination: string;
  reason: string;
}

export const BUG_COLUMN_DISPOSITIONS: Readonly<Record<string, BugColumnDisposition>> = Object.freeze(
  {
    id: {
      target: "identity_map",
      destination: "build.bug_work_item_map.bug_id",
      reason: "legacy surrogate key retained only as the resumable backfill key",
    },
    org_id: {
      target: "work_item",
      destination: "build.tickets.org_id",
      reason: "tenant key is identical on both tables",
    },
    project_id: {
      target: "work_item",
      destination: "build.tickets.project_id",
      reason: "project scope is identical on both tables",
    },
    bug_number: {
      target: "identity_map",
      destination: "build.bug_work_item_map.legacy_bug_number",
      reason: "canonical human key becomes tickets.ticket_number; a second per-project counter would be a second identity",
    },
    title: {
      target: "work_item",
      destination: "build.tickets.title",
      reason: "direct column equivalent",
    },
    description: {
      target: "work_item",
      destination: "build.tickets.description",
      reason: "direct column equivalent",
    },
    severity: {
      target: "qa_sidecar",
      destination: "build.work_item_qa_details.severity",
      reason: "no canonical counterpart; filtered by idx_bugs_org_project_severity today so it must stay an indexed column, not JSONB",
    },
    priority: {
      target: "work_item",
      destination: "build.tickets.priority",
      reason: "total one-to-one map onto ticket_priority",
    },
    status: {
      target: "work_item",
      destination: "build.tickets.status",
      reason: "mapped through state_group onto a per-project project_statuses row; the raw value is also retained in work_item_qa_details.qa_state",
    },
    steps_to_reproduce: {
      target: "qa_sidecar",
      destination: "build.work_item_qa_details.steps_to_reproduce",
      reason: "defect-only narrative field with no canonical counterpart",
    },
    expected_result: {
      target: "qa_sidecar",
      destination: "build.work_item_qa_details.expected_result",
      reason: "defect-only narrative field with no canonical counterpart",
    },
    actual_result: {
      target: "qa_sidecar",
      destination: "build.work_item_qa_details.actual_result",
      reason: "defect-only narrative field with no canonical counterpart",
    },
    environment: {
      target: "qa_sidecar",
      destination: "build.work_item_qa_details.environment",
      reason: "defect-only reproduction context; mirrors test_runs.environment",
    },
    browser_device: {
      target: "qa_sidecar",
      destination: "build.work_item_qa_details.browser_device",
      reason: "defect-only reproduction context; mirrors test_runs.browser_device",
    },
    affected_release_id: {
      target: "qa_sidecar",
      destination: "build.work_item_qa_details.affected_release_id",
      reason: "relationship data to project_releases; kept as a composite-FK column, never JSONB",
    },
    fixed_release_id: {
      target: "qa_sidecar",
      destination: "build.work_item_qa_details.fixed_release_id",
      reason: "relationship data to project_releases; kept as a composite-FK column, never JSONB",
    },
    assignee_membership_id: {
      target: "work_item",
      destination: "build.tickets.assignee_membership_id",
      reason: "direct column equivalent with the same composite actor FK",
    },
    reporter_id: {
      target: "work_item",
      destination: "build.tickets.reporter_id",
      reason: "direct column equivalent",
    },
    qa_owner_id: {
      target: "qa_sidecar",
      destination: "build.work_item_qa_details.qa_owner_user_id",
      reason: "QA ownership is a QA concern; the legacy user id is retained until the actor contraction retires it",
    },
    qa_owner_membership_id: {
      target: "qa_sidecar",
      destination: "build.work_item_qa_details.qa_owner_membership_id",
      reason: "membership pointer moves with the field and needs its own membership-artifact-catalog entry",
    },
    reopen_count: {
      target: "qa_sidecar",
      destination: "build.work_item_qa_details.reopen_count",
      reason: "historical counter is not reconstructable from the activity log for pre-cutover rows",
    },
    linked_ticket_id: {
      target: "work_item_relation",
      destination: "build.work_item_relations(relation_type='relates_to')",
      reason: "after consolidation the defect is a work item, so a bug-to-ticket link is an ordinary work-item relation",
    },
    linked_test_case_id: {
      target: "qa_sidecar",
      destination: "build.work_item_qa_details.linked_test_case_id",
      reason: "evidence link to test_cases; query-critical so it stays a composite-FK column",
    },
    created_by: {
      target: "qa_sidecar",
      destination: "build.work_item_qa_details.created_by_user_id",
      reason: "tickets has no created_by; provenance is preserved on the sidecar and replayed into ticket_activity_log",
    },
    created_at: {
      target: "work_item",
      destination: "build.tickets.created_at",
      reason: "direct equivalent; bugs.created_at is timestamp without time zone and must be cast AT TIME ZONE 'UTC'",
    },
    updated_at: {
      target: "work_item",
      destination: "build.tickets.updated_at",
      reason: "direct equivalent; same timestamp-without-time-zone cast applies",
    },
    deleted_at: {
      target: "work_item",
      destination: "build.tickets.deleted_at",
      reason: "direct equivalent; same timestamp-without-time-zone cast applies",
    },
  },
);
