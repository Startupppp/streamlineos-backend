import type { MembershipArtifact } from "../membership-artifact.types";

export const HR_WORKFORCE_ARTIFACTS = [
  {
    id: "hr_workflow_instances_requested_by_actor",
    mechanism: "database-write",
    table: "hr_workflow_instances",
    keyedBy: "requested_by_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason: "Workflow request attribution is retained for audit history; departure must explicitly resolve this RESTRICT dependency before removal.",
  },
  {
    id: "hr_workflow_instances_subject_actor",
    mechanism: "database-write",
    table: "hr_workflow_instances",
    keyedBy: "subject_employee_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason: "Workflow subject attribution is retained for audit history; departure must explicitly resolve this RESTRICT dependency before removal.",
  },
  {
    id: "hr_workflow_step_actions_approver_actor",
    mechanism: "database-write",
    table: "hr_workflow_step_actions",
    keyedBy: "approver_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason: "Workflow approval attribution is retained for audit history; departure must explicitly resolve this RESTRICT dependency before removal.",
  },
  {
    id: "hr_workflow_step_actions_acted_by_actor",
    mechanism: "database-write",
    table: "hr_workflow_step_actions",
    keyedBy: "acted_by_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason: "Workflow action attribution is retained for audit history; departure must explicitly resolve this RESTRICT dependency before removal.",
  },
  {
    id: "hr_cases",
    mechanism: "database-cascade",
    table: "hr_cases",
    keyedBy: "assigned_to_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "hr_workflow_instances_subject",
    mechanism: "database-write",
    table: "hr_workflow_instances",
    keyedBy: "subject_employee_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The workflow subject is the tenant-scoped person the instance concerns. Its composite FK is RESTRICT, so a membership cannot be removed while it remains the subject of an active workflow record.",
  },
  {
    id: "hr_workflow_step_actions_approver",
    mechanism: "database-write",
    table: "hr_workflow_step_actions",
    keyedBy: "approver_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The configured approver is workflow authority, not audit-only attribution. Its composite FK is RESTRICT, so removal requires an explicit reassignment or workflow resolution.",
  },
  {
    id: "hr_disciplinary_actions",
    mechanism: "database-cascade",
    table: "hr_disciplinary_actions",
    keyedBy: "employee_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "hr_proxy_access",
    mechanism: "database-cascade",
    table: "hr_proxy_access",
    keyedBy: "grantor_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "hr_workflow_delegations",
    mechanism: "database-write",
    table: "hr_workflow_delegations",
    keyedBy: "delegator_membership_id / delegate_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "revoke",
    reason:
      "Delegation grants authority in both directions. Both composite FKs are RESTRICT, so removal requires an explicit revocation, and suspension revokes the delegation immediately.",
  },
  {
    id: "hr_case_notes_author_membership",
    mechanism: "database-write",
    table: "hr_case_notes",
    keyedBy: "author_membership_id",
    onRemoval: "delete",
    onSuspension: "retain",
    reason:
      "The FK on (org_id, author_membership_id) is ON DELETE SET NULL without a column list, so Postgres would attempt to null both org_id (NOT NULL) and author_membership_id, raising 23502. The revocation path must explicitly clear all author_membership_id pointers for this membership before the membership row is removed.",
  },
  {
    id: "hr_benefit_enrollments_user_membership",
    mechanism: "database-write",
    table: "hr_benefit_enrollments",
    keyedBy: "user_membership_id",
    onRemoval: "delete",
    onSuspension: "retain",
    reason:
      "The FK on (org_id, user_membership_id) is ON DELETE SET NULL without a column list, so Postgres would attempt to null both org_id (NOT NULL) and user_membership_id, raising 23502. The revocation path must explicitly clear all user_membership_id pointers for this membership before the membership row is removed.",
  },
  {
    id: "hr_dependents_user_membership",
    mechanism: "database-write",
    table: "hr_dependents",
    keyedBy: "user_membership_id",
    onRemoval: "delete",
    onSuspension: "retain",
    reason:
      "The FK on (org_id, user_membership_id) is ON DELETE SET NULL without a column list, so Postgres would attempt to null both org_id (NOT NULL) and user_membership_id, raising 23502. The revocation path must explicitly clear all user_membership_id pointers for this membership before the membership row is removed.",
  },
  {
    id: "hr_insurance_claims_user_membership",
    mechanism: "database-write",
    table: "hr_insurance_claims",
    keyedBy: "user_membership_id",
    onRemoval: "delete",
    onSuspension: "retain",
    reason:
      "The FK on (org_id, user_membership_id) is ON DELETE SET NULL without a column list, so Postgres would attempt to null both org_id (NOT NULL) and user_membership_id, raising 23502. The revocation path must explicitly clear all user_membership_id pointers for this membership before the membership row is removed.",
  },
  {
    id: "hr_cases_reported_by_membership",
    mechanism: "database-cascade",
    table: "hr_cases",
    keyedBy: "reported_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Reporter attribution on hr_cases is cleared by fk_hr_cases_reported_by_actor, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "hr_insurance_claims_decided_by_membership",
    mechanism: "database-write",
    table: "hr_insurance_claims",
    keyedBy: "decided_by_membership_id",
    onRemoval: "delete",
    onSuspension: "retain",
    reason:
      "fk_hr_insurance_claims_decider_membership is ON DELETE SET NULL without a column list on the composite FK (org_id, decided_by_membership_id), so Postgres would attempt to null both org_id (NOT NULL) and decided_by_membership_id, raising 23502. The revocation path must explicitly clear all decided_by_membership_id pointers for this membership before the membership row is removed.",
  },
  {
    id: "hr_proxy_access_proxy_membership",
    mechanism: "database-cascade",
    table: "hr_proxy_access",
    keyedBy: "proxy_membership_id",
    onRemoval: "set-null",
    onSuspension: "revoke",
    reason:
      "fk_hr_proxy_access_proxy_actor nulls the delegate pointer on removal, preserving the grant history. A proxy grant is standing authority to act for another member, so a suspension revokes it rather than retaining it.",
  },
] as const satisfies readonly MembershipArtifact[];
