import { createHash, randomBytes } from "node:crypto";
import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { chatChannelInviteLinks, chatChannelMembers, chatChannels } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from "../../common/security/secret-encryption.util";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newInviteToken() {
  const token = randomBytes(24).toString("hex");
  return {
    token,
    tokenHash: hashToken(token),
    tokenEncrypted: encryptSecret(token),
  };
}

@Injectable()
export class ChatInviteLinksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertAdmin(channelId: number, userId: string, orgId: string) {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
      columns: { id: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");
    const member = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.userId, userId),
      ),
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

  async getOrCreateInviteLink(channelId: number, userId: string, orgId: string) {
    const member = await this.assertAdmin(channelId, userId, orgId);

    const existing = await this.findActiveLink(channelId);
    if (existing) {
      const shown = this.readableToken(existing);
      if (shown) return { token: shown };
    }

    const minted = newInviteToken();
    await this.db.insert(chatChannelInviteLinks).values({
      orgId: member.orgId,
      channelId,
      token: null,
      tokenHash: minted.tokenHash,
      tokenEncrypted: minted.tokenEncrypted,
      createdByMembershipId: member.membershipId ?? null,
    });
    return { token: minted.token };
  }

  async regenerateInviteLink(channelId: number, userId: string, orgId: string) {
    const member = await this.assertAdmin(channelId, userId, orgId);

    await this.db
      .update(chatChannelInviteLinks)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(chatChannelInviteLinks.channelId, channelId),
          isNull(chatChannelInviteLinks.revokedAt),
        ),
      );

    const minted = newInviteToken();
    await this.db.insert(chatChannelInviteLinks).values({
      orgId: member.orgId,
      channelId,
      token: null,
      tokenHash: minted.tokenHash,
      tokenEncrypted: minted.tokenEncrypted,
      createdByMembershipId: member.membershipId ?? null,
    });
    return { token: minted.token };
  }

  // A link minted before this column existed is still plaintext until it is regenerated.
  private readableToken(link: {
    token: string | null;
    tokenEncrypted: string | null;
  }): string | null {
    if (link.tokenEncrypted && isEncryptedSecret(link.tokenEncrypted))
      return decryptSecret(link.tokenEncrypted);
    return link.token;
  }

  async joinViaInviteLink(token: string, userId: string, orgId: string) {
    const link = await this.db.query.chatChannelInviteLinks.findFirst({
      where: and(eq(chatChannelInviteLinks.tokenHash, hashToken(token)), isNull(chatChannelInviteLinks.revokedAt)),
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
        orgId: channel.orgId,
        channelId: channel.id,
        userId,
        role: "MEMBER",
      });
    }

    return { ok: true, channelId: channel.id };
  }
}
