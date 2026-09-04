import { and, asc, eq, inArray } from "drizzle-orm";
import { chatChannelMembers, organizationMembers } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

const MENTION_PATTERN = /@([^\s@]+)/g;
const EVERYONE_ALIASES = new Set(["channel", "everyone", "here"]);

export const MENTION_RECIPIENT_CAP = 200;

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

  if (everyone) {
    const members = await db.query.chatChannelMembers.findMany({
      where: and(
        eq(chatChannelMembers.orgId, input.orgId),
        eq(chatChannelMembers.channelId, input.channelId),
      ),
      columns: { membershipId: true },
      with: { membership: { columns: { userId: true } } },
      orderBy: [asc(chatChannelMembers.membershipId)],
      limit: MENTION_RECIPIENT_CAP,
    });
    return members
      .map((member) => member.membership?.userId)
      .filter((userId): userId is string => userId !== undefined && userId !== input.senderId)
      .slice(0, MENTION_RECIPIENT_CAP);
  }

  const claimedList = [...claimed].slice(0, MENTION_RECIPIENT_CAP);
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(chatChannelMembers)
    .innerJoin(organizationMembers, eq(organizationMembers.id, chatChannelMembers.membershipId))
    .where(
      and(
        eq(chatChannelMembers.orgId, input.orgId),
        eq(chatChannelMembers.channelId, input.channelId),
        inArray(organizationMembers.userId, claimedList),
      ),
    )
    .limit(MENTION_RECIPIENT_CAP);
  return rows
    .map((r) => r.userId)
    .filter((userId) => userId !== input.senderId);
}
