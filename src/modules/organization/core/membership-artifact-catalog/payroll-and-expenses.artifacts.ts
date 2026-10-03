import type { MembershipArtifact } from "../membership-artifact.types";

export const PAYROLL_AND_EXPENSES_ARTIFACTS = [
  {
    id: "expenses",
    mechanism: "database-cascade",
    table: "expenses",
    keyedBy: "approver_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on approver_membership_id is ON DELETE SET NULL, so expense records are preserved with the approver column cleared on membership removal.",
  },
  {
    id: "payroll_run_export_jobs_requester",
    mechanism: "database-cascade",
    table: "payroll_run_export_jobs",
    keyedBy: "requested_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite FK payroll_run_export_jobs_org_requester_membership_fk is ON DELETE SET NULL (migration 0833). The export job record survives with the requester slot cleared automatically.",
  },
  {
    id: "reimbursements_approver",
    mechanism: "database-cascade",
    table: "reimbursements",
    keyedBy: "approved_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite FK fk_reimbursements_approved_actor is ON DELETE SET NULL (migration 0833). The reimbursement record survives with the approver membership slot cleared; the parallel user column (approved_by) preserves identity for display.",
  },
  {
    id: "payroll_approvals_actor",
    mechanism: "database-cascade",
    table: "payroll_approvals",
    keyedBy: "acted_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite FK fk_payroll_approvals_acted_actor is ON DELETE SET NULL (migration 0834). The approval stage record survives for payroll audit; the membership pointer is cleared automatically.",
  },
  {
    id: "payroll_journal_batches_actors",
    mechanism: "database-cascade",
    table: "payroll_journal_batches",
    keyedBy: "posted_by_membership_id / exported_by_membership_id / reversed_by_membership_id / reconciled_by_membership_id / created_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Five composite FKs (fk_payroll_jrnl_batches_*_actor) are ON DELETE SET NULL (migration 0834). Each batch lifecycle action is an attribution field with a parallel user column; clearing the membership pointer preserves the batch record and its user-level identity.",
  },
  {
    id: "payroll_runs_actors",
    mechanism: "database-cascade",
    table: "payroll_runs",
    keyedBy: "approved_by_membership_id / paid_by_membership_id / published_by_membership_id / closed_by_membership_id / reopened_by_membership_id / created_by_membership_id / locked_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Seven composite FKs (fk_payroll_runs_*_actor) are ON DELETE SET NULL (migration 0835). Each run lifecycle action is an attribution field with a parallel user column (approved_by, paid_by, etc.) that preserves identity for financial audit after the membership pointer is cleared.",
  },
  {
    id: "expense_export_jobs_requester",
    mechanism: "database-cascade",
    table: "expense_export_jobs",
    keyedBy: "requested_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite FK expense_export_jobs_org_requester_membership_fk is ON DELETE SET NULL (migration 0837). The export job record survives with the requester slot cleared automatically. Column made nullable in the same migration.",
  },
  {
    id: "payroll_inputs",
    mechanism: "database-cascade",
    table: "payroll_inputs",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "payslip_publications",
    mechanism: "database-cascade",
    table: "payslip_publications",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "payroll_run_employees",
    mechanism: "database-cascade",
    table: "payroll_run_employees",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "employee_salary_profiles",
    mechanism: "database-cascade",
    table: "employee_salary_profiles",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "hr_payroll_input_snapshots",
    mechanism: "database-cascade",
    table: "hr_payroll_input_snapshots",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "hr_payroll_adjustments",
    mechanism: "database-cascade",
    table: "hr_payroll_adjustments",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "salary_loans",
    mechanism: "database-cascade",
    table: "salary_loans",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "bonuses",
    mechanism: "database-cascade",
    table: "bonuses",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "fnf_settlements",
    mechanism: "database-cascade",
    table: "fnf_settlements",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "payroll_form16_documents",
    mechanism: "database-cascade",
    table: "payroll_form16_documents",
    keyedBy: "user_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "A Form 16 row is the employer's uploaded copy of a TRACES certificate for one member and one financial year; TRACES stays the source of record, so the composite tenant foreign key removes the copy with the membership and a suspension writes nothing.",
  },
  {
    id: "tax_declarations_user_membership",
    mechanism: "database-write",
    table: "tax_declarations",
    keyedBy: "user_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason: "Tax declarations are compliance records and require explicit preservation or reassignment before removal.",
  },
  {
    id: "hr_arrears_adjustments_user_membership",
    mechanism: "database-write",
    table: "hr_arrears_adjustments",
    keyedBy: "user_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason: "Arrears adjustments are payroll records and require explicit settlement handling before removal.",
  },
  {
    id: "hr_comp_recommendations_user_membership",
    mechanism: "database-write",
    table: "hr_comp_recommendations",
    keyedBy: "user_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason: "Compensation recommendations are employment records and require explicit handling before removal.",
  },
  {
    id: "hr_equity_grants_user_membership",
    mechanism: "database-write",
    table: "hr_equity_grants",
    keyedBy: "user_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason: "Equity grants are financial employment records and require explicit preservation or settlement before removal.",
  },
  {
    id: "expenses_user_membership",
    mechanism: "database-cascade",
    table: "expenses",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The member pointer on expenses is cleared by fk_expenses_user_actor, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "reimbursements_user_membership",
    mechanism: "database-cascade",
    table: "reimbursements",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The member pointer on reimbursements is cleared by fk_reimbursements_user_actor, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "payroll_form16_documents_actors",
    mechanism: "database-cascade",
    table: "payroll_form16_documents",
    keyedBy: "uploaded_by_membership_id / released_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The uploader and releaser pointers are composite tenant foreign keys (fk_payroll_form16_documents_uploaded_by, fk_payroll_form16_documents_released_by), each ON DELETE SET NULL, so the employee's Form 16 copy survives the departure of the payroll admin who handled it. A suspension is reversible, so nothing is written.",
  },
] as const satisfies readonly MembershipArtifact[];
