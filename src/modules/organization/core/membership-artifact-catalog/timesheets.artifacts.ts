import type { MembershipArtifact } from "../membership-artifact.types";

export const TIMESHEETS_ARTIFACTS = [
  {
    id: "timesheet_periods",
    mechanism: "database-cascade",
    table: "timesheet_periods",
    keyedBy: "current_approver_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on current_approver_membership_id is ON DELETE SET NULL, so the period record is preserved with the approver slot cleared automatically on membership removal.",
  },
  {
    id: "timesheet_exceptions",
    mechanism: "database-cascade",
    table: "timesheet_exceptions",
    keyedBy: "owner_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on owner_membership_id is ON DELETE SET NULL, so the exception record is preserved with the owner slot cleared automatically on membership removal.",
  },
  {
    id: "timesheets",
    mechanism: "database-cascade",
    table: "timesheets",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_timesheets_user_membership is ON DELETE SET NULL, so removing the member clears user_membership_id automatically while preserving the timesheet record for payroll processing and audit. Submitted time must remain payable and auditable after a member leaves. A suspension is reversible and the timesheet record must remain accessible for the current pay period, so it is retained.",
  },
  {
    id: "timer_sessions",
    mechanism: "database-cascade",
    table: "timer_sessions",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_timer_sessions_user_membership is ON DELETE SET NULL, so removing the member clears user_membership_id automatically. Timer sessions are ephemeral running state: once membership is removed the session carries no ongoing security implication and no payroll significance, so clearing the link is sufficient. A suspension is reversible and the membership gate already denies new timer operations, so the row is retained.",
  },
  {
    id: "timesheet_rates",
    mechanism: "database-cascade",
    table: "timesheet_rates",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_timesheet_rates_user_membership is ON DELETE SET NULL, so removing the member clears user_membership_id automatically while preserving the rate record for historical billing reference. A suspension is reversible so the rate configuration is retained; the membership gate already denies new time entries.",
  },
  {
    id: "timesheet_audit_events_actor_membership",
    mechanism: "database-write",
    table: "timesheet_audit_events",
    keyedBy: "actor_membership_id",
    onRemoval: "unreferenced",
    onSuspension: "retain",
    reason:
      "timesheet_audit_events is a hash-chained ledger whose row_hash covers actor_membership_id, so the pointer must outlive the membership unchanged: migration 1104 dropped fk_timesheet_audit_actor_membership, whose ON DELETE SET NULL rewrote every row the departing member had written and broke the organisation's chain at the first of them. The departure path writes nothing here; readers LEFT JOIN organization_members on (org_id, id) and render a departed actor as unresolved. A suspension is reversible, so nothing is written.",
  },
  {
    id: "timesheet_exceptions_resolved_by_membership",
    mechanism: "database-cascade",
    table: "timesheet_exceptions",
    keyedBy: "resolved_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Resolver attribution on timesheet_exceptions is cleared by fk_timesheet_exceptions_resolved_by_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "timesheet_exceptions_user_membership",
    mechanism: "database-cascade",
    table: "timesheet_exceptions",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The member pointer on timesheet_exceptions is cleared by fk_timesheet_exceptions_user_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "timesheet_exports_ack_by_membership",
    mechanism: "database-cascade",
    table: "timesheet_exports",
    keyedBy: "ack_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Acknowledgement attribution on timesheet_exports is cleared by fk_timesheet_exports_ack_by_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "timesheet_exports_created_by_membership",
    mechanism: "database-cascade",
    table: "timesheet_exports",
    keyedBy: "created_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Authorship on timesheet_exports is cleared by fk_timesheet_exports_created_by_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "timesheet_periods_approved_by_membership",
    mechanism: "database-cascade",
    table: "timesheet_periods",
    keyedBy: "approved_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Approval attribution on timesheet_periods is cleared by fk_timesheet_periods_approved_actor, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "timesheet_periods_user_membership",
    mechanism: "database-cascade",
    table: "timesheet_periods",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The member pointer on timesheet_periods is cleared by fk_timesheet_periods_user_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "timesheet_settings_history_changed_by_membership",
    mechanism: "database-cascade",
    table: "timesheet_settings_history",
    keyedBy: "changed_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Change attribution on timesheet_settings_history is cleared by fk_ts_settings_history_changed_by_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "timesheets_approved_by_membership",
    mechanism: "database-cascade",
    table: "timesheets",
    keyedBy: "approved_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Approval attribution on timesheets is cleared by fk_timesheets_approved_actor, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "timesheets_locked_by_membership",
    mechanism: "database-cascade",
    table: "timesheets",
    keyedBy: "locked_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The locker pointer on timesheets is cleared by fk_timesheets_locked_by_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
] as const satisfies readonly MembershipArtifact[];
