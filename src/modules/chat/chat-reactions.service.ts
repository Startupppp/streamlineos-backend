import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  chatChannelMembers,
  chatChannels,
  chatMessageReactions,
  chatMessages,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import { MESSAGE_REACTIONS_WITH, foldReactions } from "./chat-message-reaction-shape";

@Injectable()
export class ChatReactionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
  ) {}

  private async resolveMembershipId(
    orgId: string,
    userId: string,
  ): Promise<number | null> {
    const row = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    return row?.id ?? null;
  }

  private async assertChannelMember(
    channelId: number,
    orgId: string,
    membershipId: number,
  ): Promise<void> {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
      columns: { id: true, isPrivate: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");
    const m = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, membershipId),
      ),
      columns: { id: true },
    });
    if (!m) {
      // A private channel must not confirm its own existence to a non-member.
      if (channel.isPrivate) throw new NotFoundException("Channel not found");
      throw new ForbiddenException("You are not a member of this channel");
    }
  }

  private async assertMessage(
    messageId: number,
    channelId: number,
    orgId: string,
  ): Promise<void> {
    const [msg] = await this.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.orgId, orgId),
          eq(chatMessages.channelId, channelId),
          eq(chatMessages.isDeleted, false),
        ),
      )
      .limit(1);
    if (!msg) throw new NotFoundException("Message not found");
  }

  private async loadReactions(
    orgId: string,
    messageId: number,
  ): Promise<Record<string, string[]>> {
    // The same projection and the same folder the message reads use, so the map this
    // mutation returns and the map a refetch produces cannot drift apart.
    const rows = await this.db.query.chatMessageReactions.findMany({
      where: and(
        eq(chatMessageReactions.orgId, orgId),
        eq(chatMessageReactions.messageId, messageId),
      ),
      ...MESSAGE_REACTIONS_WITH,
    });
    return foldReactions(rows);
  }

  async addReaction(
    channelId: number,
    messageId: number,
    userId: string,
    orgId: string,
    emoji: string,
  ): Promise<{ reactions: Record<string, string[]> }> {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    if (membershipId === null)
      throw new ForbiddenException(
        "You are not a member of this organization",
      );
    await this.assertChannelMember(channelId, orgId, membershipId);
    await this.assertMessage(messageId, channelId, orgId);

    await this.db
      .insert(chatMessageReactions)
      .values({ orgId, messageId, membershipId, emoji })
      .onConflictDoNothing();

    const reactions = await this.loadReactions(orgId, messageId);
    void this.ably.publishChatEvent(orgId, channelId, "reaction:updated", {
      messageId,
      channelId,
      reactions,
    });
    return { reactions };
  }

  async removeReaction(
    channelId: number,
    messageId: number,
    userId: string,
    orgId: string,
    emoji: string,
  ): Promise<{ reactions: Record<string, string[]> }> {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    if (membershipId === null)
      throw new ForbiddenException(
        "You are not a member of this organization",
      );
    await this.assertChannelMember(channelId, orgId, membershipId);
    await this.assertMessage(messageId, channelId, orgId);

    await this.db.delete(chatMessageReactions).where(
      and(
        eq(chatMessageReactions.orgId, orgId),
        eq(chatMessageReactions.messageId, messageId),
        eq(chatMessageReactions.membershipId, membershipId),
        eq(chatMessageReactions.emoji, emoji),
      ),
    );

    const reactions = await this.loadReactions(orgId, messageId);
    void this.ably.publishChatEvent(orgId, channelId, "reaction:updated", {
      messageId,
      channelId,
      reactions,
    });
    return { reactions };
  }
}
