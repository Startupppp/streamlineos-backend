import type { MembershipArtifact } from "../membership-artifact.types";

export const CHAT_ARTIFACTS = [
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
    id: "chat_channels_creator",
    mechanism: "database-cascade",
    table: "chat_channels",
    keyedBy: "created_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_chat_channels_org_created_by_membership is ON DELETE SET NULL (migration 0831). The channel survives with the creator slot cleared automatically.",
  },
  {
    id: "chat_channel_invite_links_created_by_membership",
    mechanism: "database-cascade",
    table: "chat_channel_invite_links",
    keyedBy: "created_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Authorship on chat_channel_invite_links is cleared by fk_chat_invite_links_created_by_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "chat_huddles_started_by_membership",
    mechanism: "database-cascade",
    table: "chat_huddles",
    keyedBy: "started_by_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "fk_chat_huddles_org_starter_membership cascades: the chat_huddles row exists only for this membership and is removed with it.",
  },
  {
    id: "chat_org_settings_updated_by_membership",
    mechanism: "database-cascade",
    table: "chat_org_settings",
    keyedBy: "updated_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The last-editor pointer on chat_org_settings is cleared by fk_chat_org_settings_updated_by_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "chat_pinned_messages_pinned_by_membership",
    mechanism: "database-cascade",
    table: "chat_pinned_messages",
    keyedBy: "pinned_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Pinner attribution on chat_pinned_messages is cleared by fk_chat_pinned_messages_org_pinner_membership, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
] as const satisfies readonly MembershipArtifact[];
