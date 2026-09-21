import type { MembershipArtifact } from "../membership-artifact.types";

export const SUPPORT_ARTIFACTS = [
  {
    id: "tickets",
    mechanism: "database-cascade",
    table: "tickets",
    keyedBy: "assignee_membership_id / reporter_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Both assignee and reporter composite foreign keys are ON DELETE SET NULL, so historical attribution is preserved and membership removal is unblocked.",
  },
  {
    id: "ticket_assignees",
    mechanism: "database-cascade",
    table: "ticket_assignees",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE CASCADE, so leaving the organisation drops the ticket assignment row automatically.",
  },
  {
    id: "helpdesk_tickets",
    mechanism: "database-cascade",
    table: "helpdesk_tickets",
    keyedBy: "assignee_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE SET NULL, so the ticket survives with the assignee slot cleared automatically on membership removal.",
  },
  {
    id: "ticket_activity_log",
    mechanism: "database-cascade",
    table: "ticket_activity_log",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on user_membership_id is ON DELETE SET NULL, so activity log entries are preserved with the membership column cleared on removal.",
  },
  {
    id: "ticket_comment_mentions",
    mechanism: "database-cascade",
    table: "ticket_comment_mentions",
    keyedBy: "mentioned_user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on mentioned_user_membership_id is ON DELETE SET NULL, so mention records are preserved with the membership column cleared on removal.",
  },
  {
    id: "ticket_related_links_creator",
    mechanism: "database-cascade",
    table: "ticket_related_links",
    keyedBy: "created_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_ticket_related_links_created_by_actor is ON DELETE SET NULL (migration 0832). The link record survives with the creator slot cleared automatically.",
  },
  {
    id: "ticket_watchers",
    mechanism: "database-cascade",
    table: "ticket_watchers",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_ticket_watchers_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "ticket_checklist_items",
    mechanism: "database-cascade",
    table: "ticket_checklist_items",
    keyedBy: "assignee_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "ticket_comment_reactions",
    mechanism: "database-cascade",
    table: "ticket_comment_reactions",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_ticket_comment_reactions_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "support_tickets",
    mechanism: "database-cascade",
    table: "support_tickets",
    keyedBy: "assignee_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "support_routing_rules",
    mechanism: "database-cascade",
    table: "support_routing_rules",
    keyedBy: "assignee_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Added by the actor contraction: the row carries a membership pointer beside its legacy user id. The composite tenant foreign key nulls the pointer on removal so historical display survives, and a suspension is reversible so nothing is written.",
  },
  {
    id: "support_saved_views",
    mechanism: "database-cascade",
    table: "support_saved_views",
    keyedBy: "owner_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_support_saved_views_owner_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "support_ticket_watchers",
    mechanism: "database-cascade",
    table: "support_ticket_watchers",
    keyedBy: "user_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_support_ticket_watchers_user_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "support_agent_skills",
    mechanism: "database-cascade",
    table: "support_agent_skills",
    keyedBy: "user_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_support_agent_skills_user_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "support_agent_availability",
    mechanism: "database-cascade",
    table: "support_agent_availability",
    keyedBy: "user_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_support_agent_availability_user_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "support_message_mentions",
    mechanism: "database-cascade",
    table: "support_message_mentions",
    keyedBy: "mentioned_user_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_support_message_mentions_mentioned_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "support_ticket_drafts",
    mechanism: "database-cascade",
    table: "support_ticket_drafts",
    keyedBy: "user_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_support_ticket_drafts_user_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "hr_helpdesk_routing_assignee_membership",
    mechanism: "database-cascade",
    table: "hr_helpdesk_routing",
    keyedBy: "assignee_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Since migration 1137 a routing rule targets a queue or a person (chk_hr_helpdesk_routing_target) and fk_hr_helpdesk_routing_assignee_actor is ON DELETE SET NULL (assignee_membership_id), so removing the assignee clears the member slot and the rule keeps routing to its queue instead of blocking the removal.",
  },
  {
    id: "helpdesk_queues_escalation_membership",
    mechanism: "database-cascade",
    table: "helpdesk_queues",
    keyedBy: "escalation_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "fk_helpdesk_queues_escalation_actor is ON DELETE SET NULL (escalation_membership_id); a queue whose escalation actor left keeps its SLA defaults and the sweep escalates breached tickets to another admin member (selectEscalationTarget) until a new actor is named.",
  },
  {
    id: "hr_helpdesk_comments_author_membership",
    mechanism: "database-write",
    table: "hr_helpdesk_comments",
    keyedBy: "author_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason: "Helpdesk comment authorship is retained for audit history and requires explicit handling before membership removal.",
  },
  {
    id: "support_macros_created_by_membership",
    mechanism: "database-cascade",
    table: "support_macros",
    keyedBy: "created_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Authorship on support_macros is cleared by fk_support_macros_created_actor, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "support_tickets_created_by_membership",
    mechanism: "database-cascade",
    table: "support_tickets",
    keyedBy: "created_by_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "fk_support_tickets_created_actor is ON DELETE RESTRICT, so any member who created a support ticket is blocked from removal until those tickets are reassigned or deleted.",
  },
] as const satisfies readonly MembershipArtifact[];
