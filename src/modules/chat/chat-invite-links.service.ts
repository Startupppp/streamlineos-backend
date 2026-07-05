import { randomBytes } from "node:crypto";
import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { chatChannelInviteLinks, chatChannelMembers, chatChannels } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

@Injectable()
export class ChatInviteLinksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertAdmin(channelId: number, userId: string) {
    const member = await this.db.query.chatChannelMembers.findFirst({
      where: and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)),
    });
    if (!member) throw new ForbiddenException("You are not a member of this channel");
    if (member.role !== "ADMIN") throw new ForbiddenException("Only channel admins can manage the invite link");
    return member;
  }

  private async findActiveLink(channelId: number) {
    return this.db.query.chatChannelInviteLinks.findFirst({
      where: and(
        eq(chatChannelInviteLinks.channelId, channelId),
        isNull(chatChannelInviteLinks.revokedAt),
      ),
    });
  }

  async getOrCreateInviteLink(channelId: number, userId: string) {
    await this.assertAdmin(channelId, userId);

    const existing = await this.findActiveLink(channelId);
    if (existing) return { token: existing.token };

    const token = randomBytes(24).toString("hex");
    await this.db.insert(chatChannelInviteLinks).values({ channelId, token, createdBy: userId });
    return { token };
  }

  async regenerateInviteLink(channelId: number, userId: string) {
    await this.assertAdmin(channelId, userId);

    await this.db
      .update(chatChannelInviteLinks)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(chatChannelInviteLinks.channelId, channelId),
          isNull(chatChannelInviteLinks.revokedAt),
        ),
      );

    const token = randomBytes(24).toString("hex");
    await this.db.insert(chatChannelInviteLinks).values({ channelId, token, createdBy: userId });
    return { token };
  }

  async joinViaInviteLink(token: string, userId: string, orgId: string) {
    const link = await this.db.query.chatChannelInviteLinks.findFirst({
      where: and(eq(chatChannelInviteLinks.token, token), isNull(chatChannelInviteLinks.revokedAt)),
    });
    if (!link) throw new NotFoundException("Invite link is invalid or has been revoked");

    const channel = await this.db.query.chatChannels.findFirst({
      where: eq(chatChannels.id, link.channelId),
    });
    if (!channel || channel.orgId !== orgId) {
      throw new NotFoundException("Invite link is invalid or has been revoked");
    }

    const existingMember = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.channelId, channel.id),
        eq(chatChannelMembers.userId, userId),
      ),
    });
    if (!existingMember) {
      await this.db.insert(chatChannelMembers).values({
        channelId: channel.id,
        userId,
        role: "MEMBER",
      });
    }

    return { ok: true, channelId: channel.id };
  }
}
