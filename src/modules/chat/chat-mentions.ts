import { and, asc, eq } from "drizzle-orm";
import { chatChannelMembers } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

const MENTION_PATTERN = /@([^\s@]+)/g;
const EVERYONE_ALIASES = new Set(["channel", "everyone", "here"]);

/**
 * How many people one message may notify.
 *
 * The explicit path has always been bounded: `sendMessageSchema.mentionedUserIds` is
 * `z.array(...).max(200)` (dto/chat.schemas.ts:49), so a composer naming people can name at
 * most 200 and the resolved set is a subset of what it named. `@everyone` had no ceiling at
 * all — it read the ENTIRE roster of the channel and returned every row of it, so one
 * `@channel` in an org-wide channel produced a recipient list the size of the organisation
 * and every downstream fanout multiplied by it: a `chat_notifications` row each, a web-push
 * attempt each, a reply reminder each. Two spellings of one intent must not carry two
 * different ceilings, so this is the explicit path's ceiling applied to the implicit one.
 *
 * It bounds the READ as well as the result. Capping only the returned array would still
 * pull the whole roster into the process first, which is the cost that actually hurts.
 */
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

  /*
   * The limit rides on the `@everyone` branch only. The explicit branch keeps every row it
   * reads because a named member may sit anywhere in the roster, and truncating the read
   * there would silently drop a person the composer picked by name — bounding one path by
   * breaking the other is not a fix. Its result is already bounded by the schema's max(200).
   */
  const members = await db.query.chatChannelMembers.findMany({
    where: and(
      eq(chatChannelMembers.orgId, input.orgId),
      eq(chatChannelMembers.channelId, input.channelId),
    ),
    columns: { membershipId: true },
    with: { membership: { columns: { userId: true } } },
    orderBy: [asc(chatChannelMembers.membershipId)],
    ...(everyone ? { limit: MENTION_RECIPIENT_CAP } : {}),
  });

  const recipients = members
    .map((member) => member.membership?.userId)
    .filter((userId): userId is string => userId !== undefined && userId !== input.senderId);

  if (everyone) return recipients.slice(0, MENTION_RECIPIENT_CAP);
  return recipients.filter((userId) => claimed.has(userId));
}
