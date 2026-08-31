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
