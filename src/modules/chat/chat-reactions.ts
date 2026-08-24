export type MessageReactions = Record<string, string[]>;

// One reaction per person: a new emoji replaces whatever they had, it never stacks.
export function nextReactions(
  current: MessageReactions,
  userId: string,
  emoji: string,
): MessageReactions {
  const withoutUser: MessageReactions = {};
  for (const [key, reactors] of Object.entries(current)) {
    const filtered = reactors.filter((id) => id !== userId);
    if (filtered.length > 0) withoutUser[key] = filtered;
  }

  if ((current[emoji] ?? []).includes(userId)) return withoutUser;

  return { ...withoutUser, [emoji]: [...(withoutUser[emoji] ?? []), userId] };
}
