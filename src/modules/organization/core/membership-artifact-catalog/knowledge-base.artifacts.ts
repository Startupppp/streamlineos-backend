import type { MembershipArtifact } from "../membership-artifact.types";

export const KNOWLEDGE_BASE_ARTIFACTS = [
  {
    id: "kb_space_members",
    mechanism: "database-cascade",
    table: "kb_space_members",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_kb_space_members_org_membership was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "kb_page_restrictions",
    mechanism: "database-cascade",
    table: "kb_page_restrictions",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "This is the kb_article_restrictions ruling carried across the cutover. Migration 1174 renamed the table and renamed fk_kb_article_restrictions_org_membership to fk_kb_page_restrictions_org_membership without altering its action, so the CASCADE verified against pg_catalog on 2026-09-03 still stands. The row is per-member state keyed on the membership and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal. A restriction belonging to nobody is residue, not history.",
  },
  {
    id: "kb_page_grants",
    mechanism: "database-cascade",
    table: "kb_page_grants",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "fk_kb_page_grants_org_membership is ON DELETE CASCADE (migration 1168). The row is the grant itself, so a grant whose grantee no longer exists confers nothing on anybody and is removed with the membership.",
  },
  {
    id: "kb_page_grants_granted_by_membership",
    mechanism: "database-cascade",
    table: "kb_page_grants",
    keyedBy: "granted_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Granter attribution is cleared by fk_kb_page_grants_org_granted_by_membership, which migration 1168 wrote as ON DELETE SET NULL (\"granted_by_membership_id\") with an explicit column list, so org_id survives and the grant keeps working after the granter departs. The Drizzle declaration omits that column list, which is stale against the migration.",
  },
  {
    id: "kb_health_items_assignee_membership",
    mechanism: "database-cascade",
    table: "kb_health_items",
    keyedBy: "assignee_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "An assigned health item outlives its assignee and returns to the unassigned queue. fk_kb_health_items_org_assignee is ON DELETE SET NULL (\"assignee_membership_id\") with an explicit column list (migration 1228), so org_id is untouched and no 23502 is raised. The Drizzle declaration omits that column list, which is stale against the migration.",
  },
  {
    id: "kb_pages",
    mechanism: "database-cascade",
    table: "kb_pages",
    keyedBy: "owner_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on owner_membership_id is ON DELETE SET NULL. Ownership should be reassigned or cleared by a pre-removal step; if not, the database clears the column automatically.",
  },
  {
    id: "kb_page_favorites",
    mechanism: "database-cascade",
    table: "kb_page_favorites",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE CASCADE, so personal bookmark rows are removed with the membership automatically.",
  },
  {
    id: "kb_page_visits",
    mechanism: "database-cascade",
    table: "kb_page_visits",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE CASCADE, so read-history records are removed with the membership automatically.",
  },
  {
    id: "kb_page_reviews",
    mechanism: "database-cascade",
    table: "kb_page_reviews",
    keyedBy: "reviewer_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The foreign key on reviewer_membership_id is ON DELETE SET NULL, so the database automatically clears the reviewer reference when the membership is removed while keeping the review record intact.",
  },
  {
    id: "kb_page_versions",
    mechanism: "database-write",
    table: "kb_page_versions",
    keyedBy: "author_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The author_membership_id column is an attribution field with no FK enforcement. On removal it must be explicitly set to NULL so the version record is preserved but the membership reference is cleared.",
  },
  {
    id: "kb_chat_conversations",
    mechanism: "database-cascade",
    table: "kb_chat_conversations",
    keyedBy: "user_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_kb_chat_conv_org_user_mbr was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "kb_chat_messages",
    mechanism: "database-cascade",
    table: "kb_chat_messages",
    keyedBy: "user_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_kb_chat_msg_org_user_mbr was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "kb_research_briefs",
    mechanism: "database-cascade",
    table: "kb_research_briefs",
    keyedBy: "user_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_kb_research_briefs_org_user_mbr was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "kb_events_actor_membership",
    mechanism: "database-cascade",
    table: "kb_events",
    keyedBy: "actor_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Actor attribution on kb_events is cleared by fk_kb_events_org_actor_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "kb_page_reviews_requested_by_membership",
    mechanism: "database-cascade",
    table: "kb_page_reviews",
    keyedBy: "requested_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Requester attribution on kb_page_reviews is cleared by fk_kb_page_reviews_org_requester_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "kb_pages_created_by_membership",
    mechanism: "database-cascade",
    table: "kb_pages",
    keyedBy: "created_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Authorship on kb_pages is cleared by fk_kb_pages_org_created_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written. The Drizzle table declares this foreign key as blocking, which is stale against the migration.",
  },
  {
    id: "kb_pages_deleted_by_membership",
    mechanism: "database-cascade",
    table: "kb_pages",
    keyedBy: "deleted_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The deleter pointer on kb_pages is cleared by fk_kb_pages_org_deleted_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written. The Drizzle table declares this foreign key as blocking, which is stale against the migration.",
  },
  {
    id: "kb_pages_last_edited_by_membership",
    mechanism: "database-cascade",
    table: "kb_pages",
    keyedBy: "last_edited_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The last-editor pointer on kb_pages is cleared by fk_kb_pages_org_edited_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written. The Drizzle table declares this foreign key as blocking, which is stale against the migration.",
  },
  {
    id: "kb_pages_verified_by_membership",
    mechanism: "database-cascade",
    table: "kb_pages",
    keyedBy: "verified_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The verifier pointer on kb_pages is cleared by fk_kb_pages_org_verified_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written. The Drizzle table declares this foreign key as blocking, which is stale against the migration.",
  },
  {
    id: "kb_spaces_created_by_membership",
    mechanism: "database-cascade",
    table: "kb_spaces",
    keyedBy: "created_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Authorship on kb_spaces is cleared by fk_kb_spaces_org_created_by_mbr, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "kb_ai_interactions_actor_membership",
    mechanism: "database-cascade",
    table: "kb_ai_interactions",
    keyedBy: "actor_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The interaction log is the audit trail for what was asked of the model and what it was shown, so the row outlives the asker and only the pointer is cleared. fk_kb_ai_interactions_org_actor is ON DELETE SET NULL (\"actor_membership_id\") with an explicit column list, so org_id stays populated and the row remains inside its tenant after the departure.",
  },
  {
    id: "kb_linked_documents_published_by_membership",
    mechanism: "database-cascade",
    table: "kb_linked_documents",
    keyedBy: "published_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Who published a document to an audience is attribution, not authority — the link keeps serving its audience after the publisher departs, and revoking it on removal would silently drop a live document out of the knowledge base. fk_kb_linked_documents_published_by_actor is ON DELETE SET NULL (\"published_by_membership_id\") with an explicit column list, so org_id is untouched.",
  },
  {
    id: "kb_linked_documents_unpublished_by_membership",
    mechanism: "database-cascade",
    table: "kb_linked_documents",
    keyedBy: "unpublished_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The unpublisher pointer records who withdrew a document and is cleared by fk_kb_linked_documents_unpublished_by_actor, ON DELETE SET NULL (\"unpublished_by_membership_id\") with an explicit column list. The withdrawal itself is carried by the status column, so clearing the pointer never resurrects a withdrawn document.",
  },
  {
    id: "kb_research_briefs_approved_by_membership",
    mechanism: "database-cascade",
    table: "kb_research_briefs",
    keyedBy: "approved_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Approval attribution on a research brief is cleared by fk_kb_research_briefs_approved_by, ON DELETE SET NULL (\"approved_by_membership_id\") with an explicit column list. The brief's own approval state is a separate column, so a departed approver clears the name without reopening the decision.",
  },
] as const satisfies readonly MembershipArtifact[];
