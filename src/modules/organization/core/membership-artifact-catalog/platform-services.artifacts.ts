import type { MembershipArtifact } from "../membership-artifact.types";

export const PLATFORM_SERVICES_ARTIFACTS = [
  {
    id: "event_attendees",
    mechanism: "database-cascade",
    table: "event_attendees",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE CASCADE, so leaving the organisation drops the attendee row automatically.",
  },
  {
    id: "calendar_source_preferences",
    mechanism: "database-cascade",
    table: "calendar_source_preferences",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE CASCADE and membership_id is the only owner column, so removal deletes the toggles rather than detaching them. These are per-person calendar source preferences, not authority, so losing them on removal costs nothing. Retained through a suspension so a reactivated member keeps their calendar configuration.",
  },
  {
    id: "mail_message_metadata",
    mechanism: "database-cascade",
    table: "mail_message_metadata",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on user_membership_id is ON DELETE SET NULL, so message metadata is preserved with the membership slot cleared automatically on removal.",
  },
  {
    id: "ai_chat_conversations",
    mechanism: "database-cascade",
    table: "ai_chat_conversations",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on user_membership_id is ON DELETE SET NULL, so the conversation record is preserved with the membership slot cleared automatically. A suspension is reversible so the link is retained.",
  },
  {
    id: "ai_chat_messages",
    mechanism: "database-cascade",
    table: "ai_chat_messages",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on user_membership_id is ON DELETE SET NULL, so message records are preserved with the membership slot cleared automatically on removal.",
  },
  {
    id: "ai_feedback",
    mechanism: "database-cascade",
    table: "ai_feedback",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on user_membership_id is ON DELETE SET NULL, so feedback records are preserved with the membership slot cleared automatically on removal.",
  },
  {
    id: "ai_jobs",
    mechanism: "database-cascade",
    table: "ai_jobs",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on user_membership_id is ON DELETE SET NULL, so job records are preserved with the membership slot cleared automatically on removal.",
  },
  {
    id: "ai_action_proposals",
    mechanism: "database-cascade",
    table: "ai_action_proposals",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on user_membership_id is ON DELETE SET NULL, so action proposal records are preserved with the membership slot cleared automatically on removal.",
  },
  {
    id: "survey_forms",
    mechanism: "database-cascade",
    table: "survey_forms",
    keyedBy: "owner_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on owner_membership_id is ON DELETE SET NULL, so the survey is preserved with the owner slot cleared automatically. A suspension is reversible so the link is retained.",
  },
  {
    id: "survey_participants",
    mechanism: "database-cascade",
    table: "survey_participants",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on user_membership_id is ON DELETE SET NULL, so participation records are preserved with the membership slot cleared automatically on removal.",
  },
  {
    id: "survey_live_sessions",
    mechanism: "database-cascade",
    table: "survey_live_sessions",
    keyedBy: "host_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on host_membership_id is ON DELETE SET NULL, so the session record is preserved with the host slot cleared automatically on removal.",
  },
  {
    id: "sign_templates",
    mechanism: "database-cascade",
    table: "sign_templates",
    keyedBy: "owner_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on owner_membership_id is ON DELETE SET NULL, so the template is preserved with the owner slot cleared automatically. A suspension is reversible so the link is retained.",
  },
  {
    id: "sign_envelopes",
    mechanism: "database-cascade",
    table: "sign_envelopes",
    keyedBy: "sender_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on sender_membership_id is ON DELETE SET NULL, so the envelope record is preserved with the sender slot cleared automatically on removal.",
  },
  {
    id: "sign_recipients",
    mechanism: "database-cascade",
    table: "sign_recipients",
    keyedBy: "user_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on user_membership_id is ON DELETE SET NULL, so recipient records are preserved with the membership slot cleared automatically on removal.",
  },
  {
    id: "sign_bulk_send_jobs",
    mechanism: "database-cascade",
    table: "sign_bulk_send_jobs",
    keyedBy: "sender_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on sender_membership_id is ON DELETE SET NULL, so bulk send job records are preserved with the sender slot cleared automatically on removal.",
  },
  {
    id: "inv_user_warehouses",
    mechanism: "database-cascade",
    table: "inv_user_warehouses",
    keyedBy: "user_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "fk_inv_user_wh_user_mbr is ON DELETE CASCADE, so warehouse assignments are deleted automatically when the member leaves.",
  },
  {
    id: "inv_warehouses",
    mechanism: "database-write",
    table: "inv_warehouses",
    keyedBy: "manager_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The manager_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so the warehouse record is preserved but the membership reference is cleared.",
  },
  {
    id: "inv_quality_inspections",
    mechanism: "database-write",
    table: "inv_quality_inspections",
    keyedBy: "inspector_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The inspector_membership_id column is a companion field with no FK enforcement. On removal it must be explicitly set to NULL so inspection records are preserved but the membership reference is cleared.",
  },
  {
    id: "calendar_events_creator",
    mechanism: "database-cascade",
    table: "calendar_events",
    keyedBy: "created_by_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and cited migration 0831. 0831 did convert fk_calendar_events_org_creator_membership to ON DELETE SET NULL, and 0839 REVERTED it to NO ACTION because created_by_membership_id is NOT NULL — a column list restricts which columns are nulled, it does not make a NOT NULL column nullable, so SET NULL there raises 23502. The catalog is NO ACTION, which blocks a hard membership delete. 0839 says calendar events are 'handled explicitly through MEMBERSHIP_ARTIFACTS instead'; they are not — no runtime code reads this inventory and no departure path clears the pointer. Whether the column should become nullable is a product decision about hard deletion and erasure, pinned today by calendar-departed-actor.spec.ts, and it is recorded here as blocks-removal because that is what the database does.",
  },
  {
    id: "survey_responses_user_membership",
    mechanism: "database-write",
    table: "survey_responses",
    keyedBy: "user_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason: "Survey response ownership is tenant-scoped and must be explicitly preserved or detached before removal.",
  },
  {
    id: "ai_summary_snapshots_generated_by_membership",
    mechanism: "database-cascade",
    table: "ai_summary_snapshots",
    keyedBy: "generated_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Generator attribution on ai_summary_snapshots is cleared by fk_ai_summary_org_gen_mbr, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "audit_logs_actor_membership",
    mechanism: "database-cascade",
    table: "audit_logs",
    keyedBy: "actor_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "fk_audit_logs_org_actor_membership is ON DELETE SET NULL in the migrated schema, so the audit row survives the departure with its actor pointer cleared while actor_user_id keeps the identity. The Drizzle table declares no onDelete for this foreign key, which reads as NO ACTION and is stale against the migration.",
  },
  {
    id: "sign_documents_created_by_membership",
    mechanism: "database-cascade",
    table: "sign_documents",
    keyedBy: "created_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Authorship on sign_documents is cleared by fk_sign_doc_org_created_mbr, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "sign_envelopes_voided_by_membership",
    mechanism: "database-cascade",
    table: "sign_envelopes",
    keyedBy: "voided_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The voider pointer on sign_envelopes is cleared by fk_sign_env_org_voided_mbr, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "survey_forms_created_by_membership",
    mechanism: "database-cascade",
    table: "survey_forms",
    keyedBy: "created_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Authorship on survey_forms is cleared by fk_survey_forms_org_creator_mbr, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "survey_versions_created_by_membership",
    mechanism: "database-cascade",
    table: "survey_versions",
    keyedBy: "created_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Authorship on survey_versions is cleared by fk_survey_ver_org_creator_mbr, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "tenant_ai_credit_transactions_actor_membership",
    mechanism: "database-cascade",
    table: "tenant_ai_credit_transactions",
    keyedBy: "actor_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Actor attribution on tenant_ai_credit_transactions is cleared by fk_tenant_ai_credit_txns_org_actor_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
] as const satisfies readonly MembershipArtifact[];
