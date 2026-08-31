export type ArtifactMechanism =
  | "database-cascade"
  | "database-write"
  | "session-store"
  | "realtime"
  | "provider"
  | "cache";

export type RemovalAction =
  | "cascade"
  | "set-null"
  | "delete"
  | "revoke"
  | "blocks-removal";

export type SuspensionAction = "revoke" | "retain";

export interface MembershipArtifact {
  readonly id: string;
  readonly mechanism: ArtifactMechanism;
  readonly table: string | null;
  readonly keyedBy: string;
  readonly onRemoval: RemovalAction;
  readonly onSuspension: SuspensionAction;
  readonly reason: string;
}

export const MEMBERSHIP_ARTIFACTS = [
  {
    id: "role_assignments",
    mechanism: "database-cascade",
    table: "role_assignments",
    keyedBy: "organization_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key removes it with the membership. A suspension is reversible, so the assignment is retained and the membership gate denies instead.",
  },
  {
    id: "user_permission_grants",
    mechanism: "database-cascade",
    table: "user_permission_grants",
    keyedBy: "organization_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "A per-person grant hangs off the membership and dies with it. Retained through a suspension so a restore does not silently drop capability.",
  },
  {
    id: "principal_group_members",
    mechanism: "database-cascade",
    table: "principal_group_members",
    keyedBy: "organization_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Group edges cascade with the membership. Retained through a suspension for the same reason as a role assignment.",
  },
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
    id: "user_delegations",
    mechanism: "database-write",
    table: "user_delegations",
    keyedBy: "delegator_membership_id / delegatee_membership_id",
    onRemoval: "cascade",
    onSuspension: "revoke",
    reason:
      "A delegation is acting-for authority in both directions. It cascades on removal, and must be revoked on suspension because the delegatee is a different person whose access would otherwise outlive the delegator's standing.",
  },
  {
    id: "user_module_access",
    mechanism: "database-cascade",
    table: "user_module_access",
    keyedBy: "organization_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "A module deny-override only ever removes access, so retaining it through a suspension cannot widen anything.",
  },
  {
    id: "agent_tokens",
    mechanism: "database-write",
    table: "agent_tokens",
    keyedBy: "issuer_membership_id",
    onRemoval: "cascade",
    onSuspension: "revoke",
    reason:
      "A machine credential is bearer authority that leaves the browser. It must stop working the moment the issuer stops, not when the membership row is finally deleted.",
  },
  {
    id: "module_ownerships",
    mechanism: "database-write",
    table: "module_ownerships",
    keyedBy: "owner_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is RESTRICT on purpose: a module may not be left ownerless. Removal is refused until ownership is transferred, which is a precondition rather than a cascade.",
  },
  {
    id: "ownership_transfers",
    mechanism: "database-write",
    table: "ownership_transfers",
    keyedBy: "from_membership_id / to_membership_id / initiated_by_membership_id",
    onRemoval: "revoke",
    onSuspension: "revoke",
    reason:
      "A pending transfer naming a membership that is ending must be cancelled, or its RESTRICT foreign key blocks the removal with a misleading error.",
  },
  {
    id: "resource_grants",
    mechanism: "database-write",
    table: "resource_grants",
    keyedBy: "principal_type + principal_id",
    onRemoval: "delete",
    onSuspension: "retain",
    reason:
      "Record-level grants are polymorphic and carry no foreign key, so nothing removes them automatically. Left behind, re-inviting the same person restores their old record access.",
  },
  {
    id: "kb_space_grants",
    mechanism: "database-write",
    table: "kb_space_grants",
    keyedBy: "principal_type + principal_id",
    onRemoval: "delete",
    onSuspension: "retain",
    reason:
      "Space grants are polymorphic like resource grants and survive for the same reason.",
  },
  {
    id: "kb_space_members",
    mechanism: "database-cascade",
    table: "kb_space_members",
    keyedBy: "membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Space membership is an authority read: it decides which spaces the person can open. The composite foreign key clears membership_id on removal, at which point the row can no longer match a live member. It is retained on suspension because the row still names a legitimate grant to restore.",
  },
  {
    id: "kb_article_restrictions",
    mechanism: "database-cascade",
    table: "kb_article_restrictions",
    keyedBy: "membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "An article restriction is the per-article half of the same ACL and clears the same way. Both still carry a user_id arm during the actor transition, so a restriction whose membership is gone falls back to matching nobody rather than matching everybody.",
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
    id: "organization_people",
    mechanism: "database-write",
    table: "organization_people",
    keyedBy: "organization_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The composite foreign key (organization_id, organization_membership_id) is ON DELETE NO ACTION, so a person record that still points at a membership blocks its deletion. The removal path must reassign or detach the person record before removing the membership.",
  },
  {
    id: "invitations",
    mechanism: "database-write",
    table: "invitations",
    keyedBy: "canonical email + org",
    onRemoval: "revoke",
    onSuspension: "retain",
    reason:
      "A pending invitation for the same person is a second door into the organization. Terminal invitation history is retained rather than deleted.",
  },
  {
    id: "user_sessions",
    mechanism: "session-store",
    table: "user_sessions",
    keyedBy: "user_id",
    onRemoval: "revoke",
    onSuspension: "revoke",
    reason:
      "Sessions are account-global, so they are revoked only when this was the person's last active membership. Otherwise the membership cache bust closes this organization without signing them out of another.",
  },
  {
    id: "realtime_capability",
    mechanism: "realtime",
    table: null,
    keyedBy: "ably clientId = user_id",
    onRemoval: "revoke",
    onSuspension: "revoke",
    reason:
      "An Ably capability granting chat:${orgId}:* has a one-hour TTL and is not re-checked, so it outlives the membership unless it is explicitly withdrawn.",
  },
  {
    id: "user_integration_connections",
    mechanism: "provider",
    table: "user_integration_connections",
    keyedBy: "user_id + org_id",
    onRemoval: "revoke",
    onSuspension: "revoke",
    reason:
      "The mirror row is marked inside the revocation transaction and the provider disconnect is emitted to the outbox, so an outbound failure retries instead of silently leaving the connection live.",
  },
  {
    id: "access_caches",
    mechanism: "cache",
    table: null,
    keyedBy: "user_id + org_id",
    onRemoval: "revoke",
    onSuspension: "revoke",
    reason:
      "The resolved permission snapshot, the membership status entry and the account entry are what a request actually reads; without a bust the person keeps their old answer for the cache lifetime.",
  },
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
    id: "wfh_requests",
    mechanism: "database-cascade",
    table: "wfh_requests",
    keyedBy: "approver_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on the approver column is ON DELETE SET NULL, so WFH records are preserved with the approver column cleared on membership removal.",
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
    id: "leave_requests",
    mechanism: "database-cascade",
    table: "leave_requests",
    keyedBy: "approver_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign keys on approver_membership_id, created_by_membership_id and updated_by_membership_id are all ON DELETE SET NULL, so leave records are preserved with the membership columns cleared on removal.",
  },
  {
    id: "performance_reviews",
    mechanism: "database-cascade",
    table: "performance_reviews",
    keyedBy: "reviewer_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE SET NULL, so reviewer attribution is preserved while membership removal is unblocked.",
  },
  {
    id: "chat_user_presence",
    mechanism: "database-cascade",
    table: "chat_user_presence",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE CASCADE, so removal deletes the presence row. Presence is ephemeral heartbeat state, so nothing in the revocation path needs to clear it separately. Retained through a suspension because the suspension is reversible.",
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
    id: "chat_channel_members",
    mechanism: "database-cascade",
    table: "chat_channel_members",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE CASCADE, so the channel-membership row is dropped with the membership and no removal path is blocked. Retained through a suspension because the membership gate already denies every request while suspended.",
  },
  {
    id: "chat_messages",
    mechanism: "database-cascade",
    table: "chat_messages",
    keyedBy: "sender_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key on sender_membership_id is ON DELETE SET NULL, so the message remains renderable via the sender_id user reference while the membership pointer is cleared automatically.",
  },
  {
    id: "chat_message_reactions",
    mechanism: "database-cascade",
    table: "chat_message_reactions",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE CASCADE, so reactions are removed with the membership automatically.",
  },
  {
    id: "chat_saved_messages",
    mechanism: "database-cascade",
    table: "chat_saved_messages",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_chat_saved_messages_org_membership is ON DELETE CASCADE, so personal bookmark rows are removed with the membership automatically.",
  },
  {
    id: "chat_huddle_participants",
    mechanism: "database-cascade",
    table: "chat_huddle_participants",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_chat_huddle_participants_org_membership is ON DELETE CASCADE, so the participant row is removed with the membership automatically.",
  },
  {
    id: "chat_reply_reminders",
    mechanism: "database-write",
    table: "chat_reply_reminders",
    keyedBy: "recipient_membership_id / sender_membership_id",
    onRemoval: "delete",
    onSuspension: "retain",
    reason:
      "Two composite foreign keys (fk_chat_reply_reminders_org_recipient_membership and fk_chat_reply_reminders_org_sender_membership) are ON DELETE SET NULL but carry no column list, so a membership deletion would attempt to null org_id, which is NOT NULL. The revocation path must delete all reminders involving the membership in either role before the membership row is removed.",
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
    id: "kb_article_versions",
    mechanism: "database-write",
    table: "kb_article_versions",
    keyedBy: "author_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The author_membership_id column is an attribution field with no FK enforcement. On removal it must be explicitly set to NULL so the version record is preserved but the membership reference is cleared.",
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
    id: "org_units",
    mechanism: "database-cascade",
    table: "org_units",
    keyedBy: "head_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_org_units_head_membership is ON DELETE SET NULL, so removing the head member clears the slot automatically. A suspension is reversible and the org-membership gate already denies access, so the head pointer is retained.",
  },
  {
    id: "org_unit_members",
    mechanism: "database-cascade",
    table: "org_unit_members",
    keyedBy: "membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_org_unit_members_membership is ON DELETE SET NULL, so removing the membership clears the membership_id slot while keeping the org-unit membership row. A suspension is reversible so the link is retained.",
  },
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
      "The composite foreign key on user_membership_id is ON DELETE CASCADE, so the warehouse access grant row is removed with the membership automatically. A suspension is reversible and the membership gate already denies every request while suspended.",
  },
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
    id: "leads",
    mechanism: "database-write",
    table: "leads",
    keyedBy: "assigned_to_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Assignment companion columns (assigned_to_membership_id) carry no FK. On removal they must be explicitly set to NULL so lead records are preserved but stale membership references are cleared.",
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
    mechanism: "database-write",
    table: "clients",
    keyedBy: "account_manager_membership_id / sales_rep_membership_id / assigned_crm_membership_id / user_membership_id / assigned_to_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "All membership companion columns are attribution fields with no FK enforcement. On removal they must be explicitly set to NULL so client records are preserved but stale membership references are cleared.",
  },
  {
    id: "client_accounts",
    mechanism: "database-write",
    table: "client_accounts",
    keyedBy: "account_manager_membership_id / assigned_to_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Membership companion columns carry no FK. On removal they must be explicitly set to NULL so account records are preserved but stale membership references are cleared.",
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
] as const satisfies readonly MembershipArtifact[];

export const MEMBERSHIP_ARTIFACT_IDS = MEMBERSHIP_ARTIFACTS.map(
  (artifact) => artifact.id,
);

export const MEMBERSHIP_ARTIFACT_TABLES = MEMBERSHIP_ARTIFACTS.filter(
  (artifact) => artifact.table !== null,
).map((artifact) => artifact.table);

export function artifactsRequiringWriteOnRemoval(): readonly MembershipArtifact[] {
  return MEMBERSHIP_ARTIFACTS.filter(
    (artifact) => artifact.onRemoval !== "cascade",
  );
}

export function artifactsRequiringWriteOnSuspension(): readonly MembershipArtifact[] {
  return MEMBERSHIP_ARTIFACTS.filter(
    (artifact) => artifact.onSuspension === "revoke",
  );
}
