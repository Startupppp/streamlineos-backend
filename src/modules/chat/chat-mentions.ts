import { eq } from "drizzle-orm";
import { chatChannelMembers } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

const MENTION_PATTERN = /@([^\s@]+(?:\s[^\s@]+)*)/g;
const EVERYONE_ALIASES = new Set(["channel", "everyone", "here"]);

export interface MentionResolutionInput {
  channelId: number;
  senderId: string;
  content: string;
}

export async function resolveMentionedUserIds(
  db: Db,
  input: MentionResolutionInput,
): Promise<string[]> {
  const mentions = [...input.content.matchAll(MENTION_PATTERN)].map((match) =>
    (match[1] ?? "").toLowerCase(),
  );
  if (mentions.length === 0) return [];

  const members = await db.query.chatChannelMembers.findMany({
    where: eq(chatChannelMembers.channelId, input.channelId),
    with: { user: { columns: { id: true, name: true } } },
  });

  const recipients = members.filter((member) => member.userId !== input.senderId);

  if (mentions.some((mention) => EVERYONE_ALIASES.has(mention)))
    return recipients.map((member) => member.userId);

  return recipients
    .filter((member) => {
      const name = member.user?.name?.trim().toLowerCase() ?? "";
      if (!name) return false;
      const firstName = name.split(" ")[0] ?? "";
      return mentions.some(
        (mention) =>
          name.includes(mention) || (firstName !== "" && mention.includes(firstName)),
      );
    })
    .map((member) => member.userId);
}
