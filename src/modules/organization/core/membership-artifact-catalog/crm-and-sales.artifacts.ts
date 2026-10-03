import type { MembershipArtifact } from "../membership-artifact.types";

export const CRM_AND_SALES_ARTIFACTS = [
  {
    id: "crm_campaigns",
    mechanism: "database-write",
    table: "crm_campaigns",
    keyedBy: "owner_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The owner_membership_id column is a companion attribution field with no FK enforcement. On removal it must be explicitly set to NULL so the campaign record is preserved but the membership reference is cleared.",
  },
  {
    id: "lead_activities",
    mechanism: "database-write",
    table: "lead_activities",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The user_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so activity records are preserved but the membership reference is cleared.",
  },
  {
    id: "lead_notes",
    mechanism: "database-write",
    table: "lead_notes",
    keyedBy: "author_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The author_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so note records are preserved but the membership reference is cleared.",
  },
  {
    id: "lead_tasks",
    mechanism: "database-write",
    table: "lead_tasks",
    keyedBy: "assignee_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The assignee_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so task records are preserved but the membership reference is cleared.",
  },
  {
    id: "lead_assignment_rules",
    mechanism: "database-write",
    table: "lead_assignment_rules",
    keyedBy: "assign_to_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The assign_to_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so rule records are preserved but the membership reference is cleared.",
  },
  {
    id: "clients",
    mechanism: "database-cascade",
    table: "clients",
    keyedBy: "account_manager_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The account-manager pointer on clients is cleared by fk_clients_acct_mgr_mbr, an ON DELETE SET NULL composite tenant foreign key, so the client record survives the departure without its member pointer. A suspension is reversible, so nothing is written. The table itself is declared for its readers and never written by CRM — the row derives from the Party — which is why the pointer is only ever cleared, never rewritten.",
  },
  {
    id: "client_accounts",
    mechanism: "database-cascade",
    table: "client_accounts",
    keyedBy: "sales_rep_membership_id / assigned_crm_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Both pointers on client_accounts are cleared by fk_client_accts_sales_rep_mbr and fk_client_accts_assigned_crm_mbr, ON DELETE SET NULL composite tenant foreign keys, so account records survive the departure without their member pointers. A suspension is reversible, so nothing is written.",
  },
  {
    id: "client_account_activities",
    mechanism: "database-write",
    table: "client_account_activities",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The user_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so activity records are preserved but the membership reference is cleared.",
  },
  {
    id: "client_onboarding_items",
    mechanism: "database-write",
    table: "client_onboarding_items",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The user_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so onboarding item records are preserved but the membership reference is cleared.",
  },
  {
    id: "deals",
    mechanism: "database-write",
    table: "deals",
    keyedBy: "assigned_to_membership_id / approver_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Assignment and approver companion columns carry no FK. On removal they must be explicitly set to NULL so deal records are preserved but stale membership references are cleared.",
  },
  {
    id: "deal_activities",
    mechanism: "database-write",
    table: "deal_activities",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The user_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so activity records are preserved but the membership reference is cleared.",
  },
  {
    id: "deal_approval_rules",
    mechanism: "database-write",
    table: "deal_approval_rules",
    keyedBy: "approver_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The approver_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so rule records are preserved but the membership reference is cleared.",
  },
  {
    id: "sales_quotas",
    mechanism: "database-write",
    table: "sales_quotas",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The user_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so quota records are preserved but the membership reference is cleared.",
  },
  {
    id: "commissions",
    mechanism: "database-write",
    table: "commissions",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The user_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so commission records are preserved but the membership reference is cleared.",
  },
  {
    id: "incentives",
    mechanism: "database-write",
    table: "incentives",
    keyedBy: "sales_rep_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The sales_rep_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so incentive records are preserved but the membership reference is cleared.",
  },
  {
    id: "invoices",
    mechanism: "database-write",
    table: "invoices",
    keyedBy: "collection_owner_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The collection_owner_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so invoice records are preserved but the membership reference is cleared.",
  },
  {
    id: "coupon_redemptions",
    mechanism: "database-cascade",
    table: "coupon_redemptions",
    keyedBy: "membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "affiliates",
    mechanism: "database-cascade",
    table: "affiliates",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "client_onboarding_items_actors",
    mechanism: "database-cascade",
    table: "client_onboarding_items",
    keyedBy: "assigned_to_membership_id / completed_by_membership_id / archived_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The assignee, completer and archiver pointers are composite tenant foreign keys (fk_cob_items_assigned_to_mbr, fk_cob_items_completed_by_mbr, fk_client_onboarding_items_org_archiver_membership), each ON DELETE SET NULL over a nullable column, so the onboarding item survives the departure without the member pointer. A suspension is reversible, so nothing is written.",
  },
] as const satisfies readonly MembershipArtifact[];
