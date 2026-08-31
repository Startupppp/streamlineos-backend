import { and, eq } from "drizzle-orm";
import { chatChannelMembers } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

const MENTION_PATTERN = /@([^\s@]+)/g;
const EVERYONE_ALIASES = new Set(["channel", "everyone", "here"]);

export interface MentionResolutionInput {
  orgId: string;
  channelId: number;
  senderId: string;
  content: string;
  mentionedUserIds?: readonly string[];
}

export function mentionsEveryone(content: string): boolean {
  return [...content.matchAll(MENTION_PATTERN)].some((match) =>
    EVERYONE_ALIASES.has((match[1] ?? "").toLowerCase()),
  );
}

export async function resolveMentionedUserIds(
  db: Db,
  input: MentionResolutionInput,
): Promise<string[]> {
  const everyone = mentionsEveryone(input.content);
  const claimed = new Set(input.mentionedUserIds ?? []);
  if (!everyone && claimed.size === 0) return [];

  const members = await db.query.chatChannelMembers.findMany({
    where: and(
      eq(chatChannelMembers.orgId, input.orgId),
      eq(chatChannelMembers.channelId, input.channelId),
    ),
    columns: { membershipId: true },
    with: { membership: { columns: { userId: true } } },
  });

  const recipients = members
    .map((member) => member.membership?.userId)
    .filter((userId): userId is string => userId !== undefined && userId !== input.senderId);

  if (everyone) return recipients;
  return recipients.filter((userId) => claimed.has(userId));
}
