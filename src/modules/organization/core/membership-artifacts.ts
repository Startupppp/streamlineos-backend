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
    mechanism: "database-write",
    table: "managed_products",
    keyedBy: "owner_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The foreign key is ON DELETE SET NULL, so removing the owner leaves the product silently ownerless rather than refusing. It is inventoried so the silence is a recorded decision rather than an oversight.",
  },
  {
    id: "organization_people",
    mechanism: "database-write",
    table: "organization_people",
    keyedBy: "organization_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The person record links to the membership with ON DELETE RESTRICT, so it blocks a hard delete. It is not pre-checked today, and the failure surfaces as the unrelated \"cannot remove a member who owns a module\" message.",
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
    mechanism: "database-write",
    table: "event_attendees",
    keyedBy: "membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is RESTRICT: a member who is an event attendee cannot be removed until the attendee row is deleted first. The FK must change to CASCADE in a migration; until then removal is refused with a misleading FK-violation error.",
  },
  {
    id: "tickets",
    mechanism: "database-write",
    table: "tickets",
    keyedBy: "assignee_membership_id / reporter_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "Both assignee and reporter carry RESTRICT foreign keys: a member who is assigned to or has reported a ticket cannot be removed. Both FKs must change to SET NULL in a migration so historical attribution is preserved and the operation is unblocked.",
  },
  {
    id: "ticket_assignees",
    mechanism: "database-write",
    table: "ticket_assignees",
    keyedBy: "membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is RESTRICT: a member with any ticket assignment row cannot be removed. The FK must change to CASCADE so that leaving the organisation automatically drops the assignment link.",
  },
  {
    id: "project_members",
    mechanism: "database-write",
    table: "project_members",
    keyedBy: "membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is RESTRICT: a member who belongs to any project cannot be removed while that row exists. The FK must change to CASCADE; under suspension the org-membership gate already denies every request.",
  },
  {
    id: "project_approvals",
    mechanism: "database-write",
    table: "project_approvals",
    keyedBy: "approver_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is RESTRICT: any approval row (including completed ones) prevents membership deletion. The FK must change to SET NULL so historical approver attribution survives while removal is unblocked.",
  },
  {
    id: "wfh_requests",
    mechanism: "database-write",
    table: "wfh_requests",
    keyedBy: "approver_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is RESTRICT on the approver column: even a completed WFH request blocks removal of the approver. The FK must change to SET NULL to preserve historical records while unblocking the operation.",
  },
  {
    id: "helpdesk_tickets",
    mechanism: "database-write",
    table: "helpdesk_tickets",
    keyedBy: "assignee_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is RESTRICT: a member assigned to any helpdesk ticket cannot be removed. The FK must change to SET NULL so the ticket survives but the assignee slot is cleared.",
  },
  {
    id: "leave_requests",
    mechanism: "database-write",
    table: "leave_requests",
    keyedBy: "approver_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key on the approver column is RESTRICT: any leave request that names this member as approver blocks removal, including decided ones. The FK must change to SET NULL; the created_by and updated_by columns carry the same RESTRICT FK and likewise need changing.",
  },
  {
    id: "performance_reviews",
    mechanism: "database-write",
    table: "performance_reviews",
    keyedBy: "reviewer_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is RESTRICT: a member named as reviewer on any performance review cannot be removed. The FK must change to SET NULL so attribution survives and removal is unblocked.",
  },
  {
    id: "chat_user_presence",
    mechanism: "database-cascade",
    table: "chat_user_presence",
    keyedBy: "membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE SET NULL, so removal detaches the presence row rather than deleting it. Nothing in the revocation path clears presence, and nothing needs to: presence is ephemeral heartbeat state that goes stale on its own once the member can no longer authenticate. Retained through a suspension because the suspension is reversible.",
  },
  {
    id: "calendar_source_preferences",
    mechanism: "database-cascade",
    table: "calendar_source_preferences",
    keyedBy: "membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key is ON DELETE SET NULL. These are per-person calendar source toggles, not authority: the row also carries user_id, so the preference survives detached and is restored if the person rejoins. Retained through a suspension so a reactivated member keeps their calendar configuration.",
  },
  {
    id: "chat_channel_members",
    mechanism: "database-write",
    table: "chat_channel_members",
    keyedBy: "membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is NO ACTION (effectively RESTRICT): a member in any chat channel cannot be removed. The FK must change to CASCADE so the channel-membership row is automatically dropped.",
  },
  {
    id: "chat_messages",
    mechanism: "database-write",
    table: "chat_messages",
    keyedBy: "sender_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "There is no foreign key on sender_membership_id; the column is attribution tracking who sent the message. On removal the revocation path sets it to null so the message remains renderable via the sender_id user reference without a dangling membership pointer.",
  },
  {
    id: "chat_message_reactions",
    mechanism: "database-write",
    table: "chat_message_reactions",
    keyedBy: "membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is NO ACTION (effectively RESTRICT): a member who has ever reacted to a message cannot be removed. The FK must change to CASCADE so reactions are automatically removed with the membership.",
  },
  {
    id: "chat_saved_messages",
    mechanism: "database-write",
    table: "chat_saved_messages",
    keyedBy: "membership_id",
    onRemoval: "delete",
    onSuspension: "retain",
    reason:
      "There is no foreign key on membership_id; the rows are personal bookmarks that are not authority. On removal the revocation path deletes them so no dangling pointer outlives the membership.",
  },
  {
    id: "chat_huddle_participants",
    mechanism: "database-write",
    table: "chat_huddle_participants",
    keyedBy: "membership_id",
    onRemoval: "delete",
    onSuspension: "retain",
    reason:
      "There is no foreign key to organization_members; the row records current session participation. On removal the revocation path deletes it so a departed member is not shown as an active participant.",
  },
  {
    id: "chat_reply_reminders",
    mechanism: "database-write",
    table: "chat_reply_reminders",
    keyedBy: "recipient_membership_id / sender_membership_id",
    onRemoval: "delete",
    onSuspension: "retain",
    reason:
      "There is no foreign key on either membership column; a pending reminder naming a removed member as recipient would otherwise fire a notification to someone no longer in the org. The revocation path deletes all reminders involving the membership's user in either role.",
  },
  {
    id: "kb_pages",
    mechanism: "database-write",
    table: "kb_pages",
    keyedBy: "owner_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key on owner_membership_id is NO ACTION (RESTRICT): a member who owns any KB page cannot be removed. The FK must change to SET NULL and ownership should be reassigned or cleared by a pre-removal step.",
  },
  {
    id: "kb_page_favorites",
    mechanism: "database-write",
    table: "kb_page_favorites",
    keyedBy: "membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is NO ACTION (RESTRICT): a member with any KB page favourite cannot be removed. These are personal bookmarks with no authority impact; the FK must change to CASCADE to unblock removal.",
  },
  {
    id: "kb_page_visits",
    mechanism: "database-write",
    table: "kb_page_visits",
    keyedBy: "membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is NO ACTION (RESTRICT): any KB page visit record blocks removal. These are read-history records with no authority impact; the FK must change to CASCADE.",
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
    mechanism: "database-write",
    table: "expenses",
    keyedBy: "approver_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is RESTRICT: a member who has approved or been assigned to approve any expense cannot be removed. The FK must change to SET NULL to preserve the expense record while unblocking the operation.",
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
