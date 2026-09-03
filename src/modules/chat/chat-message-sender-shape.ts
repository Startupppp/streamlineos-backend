/**
 * The one wire shape for a chat message's sender.
 *
 * `chat_messages` has no `sender_id` column — a message reaches a person only through
 * `sender_membership_id` -> `organization_members` -> `users`. Every read path shipped that join
 * verbatim as `senderMembership`, while the client's `Message` has always declared `senderId` and
 * `sender` at the top level, and `apiClient.get<MessagesPage>` is a cast, so the compiler vouched
 * for a `senderId` the API had never sent.
 *
 * `senderId` is not decoration. `message-list.tsx:273` decides `isOwn` by
 * `msg.senderId === currentUserId`, so every message a user had sent rendered as somebody else's
 * and the Edit and Delete controls — both `{isOwn && ...}` in `chat-message-actions.tsx` — never
 * appeared on it. `:276` groups by `prevMsg?.senderId === msg.senderId`, and `undefined ===
 * undefined` is true, so consecutive messages from DIFFERENT people collapsed under one header.
 * Only the Ably broadcast and the optimistic insert carried `senderId`, which is why a message
 * looked right as it was sent and flipped the moment the list refetched.
 *
 * The saved-messages list additionally never flattened `sender` at all, so every card in that panel
 * resolved to "Unknown" with a blank avatar.
 *
 * The join is flattened here, once, and the read paths that emit a message go through it, so chat
 * has one message shape rather than five. This is the same treatment `flattenChannelMember` gives a
 * channel member and `loadHuddleWire` gives a huddle participant.
 */

export interface MessageSenderUser {
  id: string;
  name: string | null;
  image: string | null;
}

export interface NestedSenderRow {
  senderMembership?: { userId?: string | null; user?: MessageSenderUser | null } | null;
}

/** The sub-select for a path that resolves the display name itself (the person seam). */
export const SENDER_MEMBERSHIP_ID_ONLY = { columns: { userId: true } } as const;

/** The sub-select for a path that takes the display name straight off the `users` join. */
export const SENDER_MEMBERSHIP_WITH_USER = {
  columns: { userId: true },
  with: { user: { columns: { id: true, name: true, image: true } } },
} as const;

/**
 * Lift `senderMembership.userId` to `senderId` and drop the join wrapper.
 *
 * For a path that computes `sender` from somewhere else and only needs the identity key.
 * A message whose `organization_members` row is gone lifts to `senderId: null` rather than to a
 * missing key, so `msg.senderId === currentUserId` answers false instead of matching another
 * message that is also missing the key.
 */
export function liftSenderId<T extends NestedSenderRow>(
  row: T,
): Omit<T, "senderMembership"> & { senderId: string | null } {
  const { senderMembership, ...rest } = row;
  return { ...rest, senderId: senderMembership?.userId ?? null };
}

/** Lift both `senderId` and `sender` off the join, for a path whose sender IS the `users` row. */
export function flattenMessageSender<T extends NestedSenderRow>(
  row: T,
): Omit<T, "senderMembership"> & { senderId: string | null; sender: MessageSenderUser | null } {
  const { senderMembership, ...rest } = row;
  return {
    ...rest,
    senderId: senderMembership?.userId ?? null,
    sender: senderMembership?.user ?? null,
  };
}
