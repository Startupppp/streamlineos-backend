/**
 * The one wire shape for a message's reactions, and the one projection that produces it.
 *
 * Reactions were persisted correctly and never read back. `POST .../reactions` returned the
 * full map and `useToggleReaction` (frontend `hooks/api/chat-core-mutations-b.ts:184-187`)
 * invalidates `queryKeys.chat.messages(channelId)` on success, so the mutation itself
 * triggers a refetch of `GET /chat/channels/:id/messages` — whose projection carried
 * `attachments`, `senderMembership` and `replyTo` and no reactions at all. `chat-bubble.tsx`
 * renders `message.reactions && Object.keys(message.reactions).length > 0`, so the emoji the
 * user had just added disappeared the moment that refetch landed, and no reaction was ever
 * visible after a page reload. `poll()` and the thread reader had the same gap.
 *
 * The map is `emoji -> userId[]`, which is what `ChatReactionsService` already returns from
 * the mutation and what the realtime `reaction:updated` payload carries
 * (`hooks/api/chat-realtime-schema.ts:58`), so the read path and the write path now produce
 * the same object from the same folder rather than two hand-rolled ones.
 */

/** The `with:` sub-select. `membershipId` is not on the wire; it is the join key. */
export const MESSAGE_REACTIONS_WITH = {
  columns: { emoji: true },
  with: { membership: { columns: { userId: true } } },
} as const;

export interface ReactionRow {
  emoji: string;
  membership?: { userId: string | null } | null;
}

/**
 * A reaction whose `organization_members` row is gone contributes its emoji with no user id
 * rather than dropping the emoji: the bubble renders the count, and a reaction from a
 * departed colleague is still a reaction that was made.
 */
export function foldReactions(rows: readonly ReactionRow[]): Record<string, string[]> {
  const reactions: Record<string, string[]> = {};
  for (const row of rows) {
    const members = reactions[row.emoji] ?? [];
    if (row.membership?.userId) members.push(row.membership.userId);
    reactions[row.emoji] = members;
  }
  return reactions;
}
