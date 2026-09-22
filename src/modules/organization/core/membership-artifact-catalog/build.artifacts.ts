import type { MembershipArtifact } from "../membership-artifact.types";

export const BUILD_ARTIFACTS = [
  {
    id: "pm_workspace_memberships",
    mechanism: "database-cascade",
    table: "pm_workspace_memberships",
    keyedBy: "organization_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Workspace membership cascades. The org membership gate already denies every request while suspended.",
  },
  {
    id: "managed_products",
    mechanism: "database-cascade",
    table: "managed_products",
    keyedBy: "owner_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on owner_membership_id is ON DELETE SET NULL, so removing the owner leaves the product ownerless rather than refusing the deletion.",
  },
  {
    id: "project_members",
    mechanism: "database-cascade",
    table: "project_members",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE CASCADE, so leaving the organisation removes the project membership row automatically. The org-membership gate already denies every request while suspended.",
  },
  {
    id: "project_approvals",
    mechanism: "database-cascade",
    table: "project_approvals",
    keyedBy: "approver_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE SET NULL, so historical approver attribution is preserved while membership removal is unblocked.",
  },
  {
    id: "tasks",
    mechanism: "database-write",
    table: "tasks",
    keyedBy: "assignee_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The assignee_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so task records are preserved but the membership reference is cleared.",
  },
  {
    id: "sprint_scope_events_actor",
    mechanism: "database-cascade",
    table: "sprint_scope_events",
    keyedBy: "actor_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_sprint_scope_events_actor is ON DELETE SET NULL (migration 0832). The event record survives with the actor slot cleared automatically.",
  },
  {
    id: "workflow_transitions_creator",
    mechanism: "database-cascade",
    table: "workflow_transitions",
    keyedBy: "created_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_workflow_transitions_created_by_actor is ON DELETE SET NULL (migration 0832). The transition definition survives with the creator slot cleared automatically.",
  },
  {
    id: "projects",
    mechanism: "database-cascade",
    table: "projects",
    keyedBy: "client_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "okr_goals",
    mechanism: "database-cascade",
    table: "okr_goals",
    keyedBy: "owner_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "project_whiteboard_shares",
    mechanism: "database-cascade",
    table: "project_whiteboard_shares",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_whiteboard_shares_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "test_runs",
    mechanism: "database-cascade",
    table: "test_runs",
    keyedBy: "tester_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "bugs",
    mechanism: "database-cascade",
    table: "bugs",
    keyedBy: "assignee_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "change_requests",
    mechanism: "database-cascade",
    table: "change_requests",
    keyedBy: "approval_owner_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "meeting_attendees",
    mechanism: "database-cascade",
    table: "meeting_attendees",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_meeting_attendees_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "meeting_standup_entries",
    mechanism: "database-cascade",
    table: "meeting_standup_entries",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_meeting_standup_entries_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "project_team_members",
    mechanism: "database-cascade",
    table: "project_team_members",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_project_team_members_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "project_workspace_members",
    mechanism: "database-cascade",
    table: "project_workspace_members",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_project_workspace_members_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "feedbucket_submissions",
    mechanism: "database-cascade",
    table: "feedbucket_submissions",
    keyedBy: "assignee_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "comment_drafts",
    mechanism: "database-cascade",
    table: "comment_drafts",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_comment_drafts_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "bugs_qa_owner_membership",
    mechanism: "database-cascade",
    table: "bugs",
    keyedBy: "qa_owner_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The QA-owner pointer on bugs is cleared by fk_bugs_qa_owner_actor, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "okr_goals_created_by_membership",
    mechanism: "database-cascade",
    table: "okr_goals",
    keyedBy: "created_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Authorship on okr_goals is cleared by fk_okr_goals_created_by_actor, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "projects_manager_membership",
    mechanism: "database-cascade",
    table: "projects",
    keyedBy: "manager_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The manager pointer on projects is cleared by fk_projects_manager_actor, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "managed_product_memberships",
    mechanism: "database-cascade",
    table: "managed_product_memberships",
    keyedBy: "organization_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_mp_members_org_membership is ON DELETE CASCADE, so removing the membership removes the product-membership row automatically. A suspension is reversible, so nothing is written.",
  },
  {
    id: "feedbucket_widgets_default_assignee",
    mechanism: "database-write",
    table: "feedbucket_widgets",
    keyedBy: "default_assignee_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The default_assignee_membership_id column carries no foreign key, so removing a membership does not touch it automatically. It must be explicitly set to NULL so the widget configuration does not point at a removed member.",
  },
  {
    id: "project_updates_author",
    mechanism: "database-cascade",
    table: "project_updates",
    keyedBy: "author_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_project_updates_org_author is ON DELETE RESTRICT and the column is NOT NULL, so removing the authoring member is blocked until the update rows are handled. The author attribution cannot be nulled without migrating the column to nullable first.",
  },
  {
    id: "project_attachments_uploader",
    mechanism: "database-cascade",
    table: "project_attachments",
    keyedBy: "uploaded_by_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_project_attachments_org_uploader is ON DELETE RESTRICT and the column is NOT NULL, so removing the uploading member is blocked until the attachment rows are handled. The uploader attribution cannot be nulled without migrating the column to nullable first.",
  },
] as const satisfies readonly MembershipArtifact[];
