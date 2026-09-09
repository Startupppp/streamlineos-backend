import { createHash, randomBytes } from "node:crypto";
import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { chatChannelInviteLinks, chatChannelMembers, chatChannels, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../db/drizzle.types";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from "../../common/security/secret-encryption.util";
import type { ChatInviteLinkMintOptions } from "./dto/chat-invite-link-mint.schema";

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

function validLinkCondition() {
  return and(
    isNull(chatChannelInviteLinks.revokedAt),
    sql`(${chatChannelInviteLinks.expiresAt} IS NULL OR ${chatChannelInviteLinks.expiresAt} > now())`,
    sql`(${chatChannelInviteLinks.maxUses} IS NULL OR ${chatChannelInviteLinks.useCount} < ${chatChannelInviteLinks.maxUses})`,
  );
}

@Injectable()
export class ChatInviteLinksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertAdmin(channelId: number, userId: string, orgId: string) {
    const orgMember = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId), eq(organizationMembers.status, "ACTIVE")),
      columns: { id: true },
    });
    if (!orgMember) throw new NotFoundException("Channel not found");
    const member = await this.db.query.chatChannelMembers.findFirst({
      where: and(eq(chatChannelMembers.orgId, orgId), eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.membershipId, orgMember.id)),
    });
    if (!member) throw new NotFoundException("Channel not found");
    if (member.role !== "ADMIN") throw new ForbiddenException("Only channel admins can manage the invite link");
    return member;
  }

  private async findActiveLink(orgId: string, channelId: number, executor: Db | TenantTx = this.db) {
    return executor.query.chatChannelInviteLinks.findFirst({
      where: and(
        eq(chatChannelInviteLinks.orgId, orgId),
        eq(chatChannelInviteLinks.channelId, channelId),
        validLinkCondition(),
      ),
    });
  }

  private readableToken(link: {
    token: string | null;
    tokenEncrypted: string | null;
  }): string | null {
    if (link.tokenEncrypted && isEncryptedSecret(link.tokenEncrypted))
      return decryptSecret(link.tokenEncrypted);
    return link.token;
  }

  private buildTokenResponse(
    link: { expiresAt: Date | null; maxUses: number | null; useCount: number },
    token: string,
  ) {
    return { token, expiresAt: link.expiresAt, maxUses: link.maxUses, useCount: link.useCount };
  }

  async getOrCreateInviteLink(channelId: number, userId: string, orgId: string, options?: ChatInviteLinkMintOptions) {
    const member = await this.assertAdmin(channelId, userId, orgId);

    const existing = await this.findActiveLink(orgId, channelId);
    if (existing) {
      const shown = this.readableToken(existing);
      if (shown) return this.buildTokenResponse(existing, shown);
    }

    return this.db.transaction(async (tx) => {
      const recheck = await this.findActiveLink(orgId, channelId, tx);
      if (recheck) {
        const shown = this.readableToken(recheck);
        if (shown) return this.buildTokenResponse(recheck, shown);
      }

      await tx
        .update(chatChannelInviteLinks)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(chatChannelInviteLinks.orgId, orgId),
            eq(chatChannelInviteLinks.channelId, channelId),
            isNull(chatChannelInviteLinks.revokedAt),
          ),
        );

      const minted = newInviteToken();
      const expiresAt = options?.ttlSeconds ? new Date(Date.now() + options.ttlSeconds * 1000) : null;
      const maxUses = options?.maxUses ?? null;

      const [inserted] = await tx
        .insert(chatChannelInviteLinks)
        .values({
          orgId: member.orgId,
          channelId,
          token: null,
          tokenHash: minted.tokenHash,
          tokenEncrypted: minted.tokenEncrypted,
          createdByMembershipId: member.membershipId ?? null,
          expiresAt,
          maxUses,
          useCount: 0,
        })
        .onConflictDoNothing()
        .returning({ id: chatChannelInviteLinks.id });

      if (!inserted) {
        const winner = await this.findActiveLink(orgId, channelId, tx);
        if (winner) {
          const shown = this.readableToken(winner);
          if (shown) return this.buildTokenResponse(winner, shown);
        }
        throw new NotFoundException("Channel not found");
      }

      return { token: minted.token, expiresAt, maxUses, useCount: 0 };
    });
  }

  async regenerateInviteLink(channelId: number, userId: string, orgId: string, options?: ChatInviteLinkMintOptions) {
    const member = await this.assertAdmin(channelId, userId, orgId);

    await this.db
      .update(chatChannelInviteLinks)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(chatChannelInviteLinks.orgId, orgId),
          eq(chatChannelInviteLinks.channelId, channelId),
          isNull(chatChannelInviteLinks.revokedAt),
        ),
      );

    const minted = newInviteToken();
    const expiresAt = options?.ttlSeconds ? new Date(Date.now() + options.ttlSeconds * 1000) : null;
    const maxUses = options?.maxUses ?? null;

    await this.db.insert(chatChannelInviteLinks).values({
      orgId: member.orgId,
      channelId,
      token: null,
      tokenHash: minted.tokenHash,
      tokenEncrypted: minted.tokenEncrypted,
      createdByMembershipId: member.membershipId ?? null,
      expiresAt,
      maxUses,
      useCount: 0,
    });

    return { token: minted.token, expiresAt, maxUses, useCount: 0 };
  }

  async joinViaInviteLink(token: string, userId: string, orgId: string) {
    const link = await this.db.query.chatChannelInviteLinks.findFirst({
      where: and(
        eq(chatChannelInviteLinks.orgId, orgId),
        eq(chatChannelInviteLinks.tokenHash, hashToken(token)),
        validLinkCondition(),
      ),
    });
    if (!link) throw new NotFoundException("Invite link is invalid or has been revoked");

    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.orgId, orgId), eq(chatChannels.id, link.channelId)),
      columns: { id: true, orgId: true, isArchived: true },
    });
    if (!channel || channel.isArchived)
      throw new NotFoundException("Invite link is invalid or has been revoked");

    const joinerOrgMember = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId), eq(organizationMembers.status, "ACTIVE")),
      columns: { id: true },
    });
    if (!joinerOrgMember) throw new ForbiddenException("You are not a member of this organization");

    return this.db.transaction(async (tx) => {
      const existingMember = await tx.query.chatChannelMembers.findFirst({
        where: and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channel.id),
          eq(chatChannelMembers.membershipId, joinerOrgMember.id),
        ),
        columns: { id: true },
      });

      if (!existingMember) {
        await tx.insert(chatChannelMembers).values({
          orgId: channel.orgId,
          channelId: channel.id,
          membershipId: joinerOrgMember.id,
          role: "MEMBER",
        });

        const [updated] = await tx
          .update(chatChannelInviteLinks)
          .set({ useCount: sql`${chatChannelInviteLinks.useCount} + 1` })
          .where(
            and(
              eq(chatChannelInviteLinks.id, link.id),
              isNull(chatChannelInviteLinks.revokedAt),
              sql`(${chatChannelInviteLinks.expiresAt} IS NULL OR ${chatChannelInviteLinks.expiresAt} > now())`,
              sql`(${chatChannelInviteLinks.maxUses} IS NULL OR ${chatChannelInviteLinks.useCount} < ${chatChannelInviteLinks.maxUses})`,
            ),
          )
          .returning({ id: chatChannelInviteLinks.id });

        if (!updated)
          throw new NotFoundException("Invite link is invalid or has been revoked");
      }

      return { ok: true as const, channelId: channel.id };
    });
  }
}
