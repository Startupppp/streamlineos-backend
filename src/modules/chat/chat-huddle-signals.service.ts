import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  chatChannelMembers,
  chatChannels,
  chatHuddleParticipants,
  chatHuddles,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import type { HuddleSignalInput } from "./dto/huddle.schemas";

@Injectable()
export class ChatHuddleSignalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
  ) {}

  private async assertMember(channelId: number, userId: string, orgId: string): Promise<number> {
    const activeMembership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!activeMembership) throw new ForbiddenException("Your membership is no longer active");
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
      columns: { isArchived: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");
    const member = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, activeMembership.id),
      ),
    });
    if (!member) throw new ForbiddenException("You are not a member of this channel");
    if (channel.isArchived) throw new ForbiddenException("Channel is archived");
    return activeMembership.id;
  }

  async setMute(huddleId: number, userId: string, muted: boolean, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    const callerMembershipId = await this.assertMember(huddle.channelId, userId, orgId);

    await this.db
      .update(chatHuddleParticipants)
      .set({ isMuted: muted })
      .where(
        and(
          eq(chatHuddleParticipants.orgId, orgId),
          eq(chatHuddleParticipants.huddleId, huddleId),
          eq(chatHuddleParticipants.membershipId, callerMembershipId),
          isNull(chatHuddleParticipants.leftAt),
        ),
      );

    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", { huddleId, userId, isMuted: muted });
    return { ok: true };
  }

  async setDeafen(huddleId: number, userId: string, orgId: string, deafened: boolean) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    const callerMembershipId = await this.assertMember(huddle.channelId, userId, orgId);
    await this.db.update(chatHuddleParticipants).set({ isDeafened: deafened })
      .where(
        and(
          eq(chatHuddleParticipants.orgId, orgId),
          eq(chatHuddleParticipants.huddleId, huddleId),
          eq(chatHuddleParticipants.membershipId, callerMembershipId),
        ),
      );
    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", { huddleId, userId, isDeafened: deafened });
    return { ok: true };
  }

  async raiseHand(huddleId: number, userId: string, raised: boolean, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    const callerMembershipId = await this.assertMember(huddle.channelId, userId, orgId);

    await this.db
      .update(chatHuddleParticipants)
      .set({ handRaised: raised })
      .where(
        and(
          eq(chatHuddleParticipants.orgId, orgId),
          eq(chatHuddleParticipants.huddleId, huddleId),
          eq(chatHuddleParticipants.membershipId, callerMembershipId),
          isNull(chatHuddleParticipants.leftAt),
        ),
      );

    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", { huddleId, userId, handRaised: raised });
    return { ok: true };
  }

  async sendSignal(huddleId: number, fromUserId: string, signal: HuddleSignalInput, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, fromUserId, orgId);

    await this.ably.publishHuddleSignal(orgId, huddle.channelId, signal.targetUserId, {
      fromUserId,
      type: signal.type,
      payload: signal.payload,
    });

    return { ok: true };
  }

  async heartbeat(huddleId: number, userId: string, orgId: string): Promise<{ ok: boolean }> {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId)),
      columns: { id: true },
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    const callerMembership = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
      columns: { id: true },
    });
    if (!callerMembership) throw new ForbiddenException("Your membership is no longer active");
    await this.db
      .update(chatHuddleParticipants)
      .set({ lastSeenAt: sql`now()` })
      .where(
        and(
          eq(chatHuddleParticipants.orgId, orgId),
          eq(chatHuddleParticipants.huddleId, huddleId),
          eq(chatHuddleParticipants.membershipId, callerMembership.id),
          isNull(chatHuddleParticipants.leftAt),
        ),
      );
    return { ok: true };
  }

  async setScreenShare(huddleId: number, userId: string, isScreenSharing: boolean, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    const callerMembershipId = await this.assertMember(huddle.channelId, userId, orgId);
    await this.db
      .update(chatHuddleParticipants)
      .set({ isScreenSharing })
      .where(
        and(
          eq(chatHuddleParticipants.orgId, orgId),
          eq(chatHuddleParticipants.huddleId, huddleId),
          eq(chatHuddleParticipants.membershipId, callerMembershipId),
          isNull(chatHuddleParticipants.leftAt),
        ),
      );
    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", { huddleId, userId, isScreenSharing });
    return { ok: true };
  }
}
