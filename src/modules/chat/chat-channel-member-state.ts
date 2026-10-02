import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { chatChannelMembers, chatChannels, chatMessages } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { DRIZZLE } from "../../db/drizzle.constants";
import { assertChannelMember } from "./chat-channel-authorization";
import type { MuteDuration } from "./dto/chat.schemas";

const MUTE_UNTIL_FROM: Record<MuteDuration, () => Date> = {
  "15m": () => new Date(Date.now() + 900_000),
  "1h": () => new Date(Date.now() + 3_600_000),
  "8h": () => new Date(Date.now() + 28_800_000),
  "24h": () => new Date(Date.now() + 86_400_000),
  "forever": () => new Date("2099-12-31"),
};

export function channelHighWaterMark(channelId: number, orgId: string) {
  return sql<number>`COALESCE((SELECT ${chatChannels.messageCount} FROM ${chatChannels} WHERE ${chatChannels.id} = ${channelId} AND ${chatChannels.orgId} = ${orgId}), 0)`;
}

@Injectable()
export class ChatChannelMemberState {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async archiveChannel(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true };
  }

  async unarchiveChannel(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({ archivedAt: null })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true };
  }

  async markRead(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    // GREATEST, not assignment: two marks in flight together commit in either order,
    // and a plain write lets the older one rewind the cursor and resurrect read messages.
    const readAt = new Date().toISOString();
    const highWaterMark = channelHighWaterMark(channelId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({
        lastReadAt: sql`GREATEST(${chatChannelMembers.lastReadAt}, ${readAt}::timestamp)`,
        lastReadPosition: sql`GREATEST(${chatChannelMembers.lastReadPosition}, ${highWaterMark})`,
      })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );

    return { ok: true };
  }

  async markChannelUnread(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    const latestMessage = await this.db
      .select({ channelPosition: chatMessages.channelPosition, createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(and(eq(chatMessages.orgId, orgId), eq(chatMessages.channelId, channelId), eq(chatMessages.isDeleted, false)))
      .orderBy(desc(chatMessages.channelPosition))
      .limit(1)
      .then((rows) => rows[0]);

    const lastReadPosition = latestMessage
      ? Math.max(latestMessage.channelPosition - 1, 0)
      : 0;
    const lastReadAt = latestMessage?.createdAt
      ? new Date(new Date(latestMessage.createdAt).getTime() - 1)
      : new Date(0);

    await this.db
      .update(chatChannelMembers)
      .set({ lastReadAt, lastReadPosition })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );

    return { ok: true };
  }

  async muteChannel(channelId: number, userId: string, duration: MuteDuration, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    const until = MUTE_UNTIL_FROM[duration]();
    await this.db
      .update(chatChannelMembers)
      .set({ mutedUntil: until })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true, mutedUntil: until };
  }

  async unmuteChannel(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({ mutedUntil: null })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true };
  }

  async favoriteChannel(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({ isFavorite: true })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true };
  }

  async unfavoriteChannel(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({ isFavorite: false })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true };
  }

  async setNotificationPreference(channelId: number, userId: string, preference: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.db
      .update(chatChannelMembers)
      .set({ notificationPreference: preference })
      .where(
        and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return { ok: true, notificationPreference: preference };
  }

}
