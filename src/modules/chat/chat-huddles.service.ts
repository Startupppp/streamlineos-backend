import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  calendarEvents,
  chatChannelMembers,
  chatChannels,
  chatHuddleParticipants,
  chatHuddles,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import { WebPushService } from "../realtime/web-push.service";
import { AuditService } from "../../common/audit/audit.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import type { HuddleSignalInput } from "./dto/huddle.schemas";

@Injectable()
export class ChatHuddlesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
    private readonly webPush: WebPushService,
    private readonly audit: AuditService,
    private readonly orgSettings: ChatOrgSettingsService,
  ) {}

  private async assertMember(channelId: number, userId: string) {
    const member = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.userId, userId),
      ),
    });
    if (!member) throw new ForbiddenException("You are not a member of this channel");
    const channel = await this.db.query.chatChannels.findFirst({
      where: eq(chatChannels.id, channelId),
      columns: { isArchived: true },
    });
    if (channel?.isArchived) throw new ForbiddenException("Channel is archived");
    return member;
  }

  async getActiveHuddle(channelId: number, userId: string) {
    await this.assertMember(channelId, userId);
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.channelId, channelId), eq(chatHuddles.status, "active")),
      with: {
        participants: {
          where: isNull(chatHuddleParticipants.leftAt),
          with: {
            user: { columns: { id: true, name: true, image: true } },
          },
        },
        startedByUser: { columns: { id: true, name: true } },
      },
    });
    if (huddle && huddle.endedAt) {
      await this.db.update(chatHuddles).set({ status: "ended" }).where(eq(chatHuddles.id, huddle.id));
      return null;
    }
    return huddle ?? null;
  }

  async startHuddle(channelId: number, userId: string, orgId: string) {
    await this.assertMember(channelId, userId);

    const existing = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.channelId, channelId), eq(chatHuddles.status, "active")),
    });
    if (existing) {
      await this.joinHuddle(existing.id, userId, orgId);
      return existing;
    }

    const channel = await this.db.query.chatChannels.findFirst({
      where: eq(chatChannels.id, channelId),
      columns: { name: true },
    });

    const channelMembers = await this.db
      .select({ userId: chatChannelMembers.userId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.channelId, channelId));

    const now = new Date();
    const estimatedEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const huddle = await this.db.transaction(async (tx) => {
      const [calEvent] = await tx
        .insert(calendarEvents)
        .values({
          orgId,
          title: `Huddle in #${channel?.name ?? "channel"}`,
          category: "huddle",
          entityType: "huddle",
          entityId: channelId.toString(),
          startDate: now,
          endDate: estimatedEnd,
          allDay: false,
          attendeeIds: channelMembers.map((m) => m.userId),
          createdBy: userId,
        })
        .returning({ id: calendarEvents.id });

      const [created] = await tx
        .insert(chatHuddles)
        .values({ channelId, startedBy: userId, status: "active", calendarEventId: calEvent?.id, hasVideo: false })
        .returning();

      await tx.insert(chatHuddleParticipants).values({ huddleId: created.id, userId });

      return created;
    });

    await this.ably.publishHuddleEvent(orgId, channelId, "huddle:started", {
      huddleId: huddle.id,
      channelId,
      startedBy: userId,
    });

    for (const member of channelMembers) {
      if (member.userId !== userId) {
        void this.ably.publishToUser(orgId, member.userId, "huddle:started", {
          huddleId: huddle.id,
          channelId,
          startedBy: userId,
        }).catch(() => {});
      }
    }

    this.audit.log({ action: "huddle.started", userId, orgId, targetId: String(huddle.id), targetType: "huddle", metadata: { channelId } });

    for (const member of channelMembers) {
      if (member.userId !== userId) {
        void this.webPush.sendToUser(member.userId, {
          title: "Huddle started",
          body: `Someone started a huddle in the channel. Join now!`,
          url: `/chat?channel=${channelId}&joinHuddle=1`,
        }).catch(() => {});
      }
    }

    return huddle;
  }

  async joinHuddle(huddleId: number, userId: string, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found or already ended");

    await this.assertMember(huddle.channelId, userId);

    const activeParticipants = await this.db.query.chatHuddleParticipants.findMany({
      where: and(eq(chatHuddleParticipants.huddleId, huddleId), isNull(chatHuddleParticipants.leftAt)),
      columns: { userId: true },
    });
    const alreadyActive = activeParticipants.some((p) => p.userId === userId);
    if (!alreadyActive) {
      const { maxHuddleParticipants } = await this.orgSettings.getSettings(orgId);
      if (activeParticipants.length >= maxHuddleParticipants) {
        throw new ForbiddenException(
          `This call is full (max ${maxHuddleParticipants} participants)`,
        );
      }
    }

    await this.db
      .insert(chatHuddleParticipants)
      .values({ huddleId, userId })
      .onConflictDoUpdate({
        target: [chatHuddleParticipants.huddleId, chatHuddleParticipants.userId],
        set: { leftAt: null, joinedAt: new Date(), isMuted: false, handRaised: false },
      });

    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:user_joined", {
      huddleId,
      userId,
      channelId: huddle.channelId,
    });

    this.audit.log({ action: "huddle.joined", userId, orgId, targetId: String(huddleId), targetType: "huddle" });

    return { ok: true };
  }

  async leaveHuddle(huddleId: number, userId: string, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found or already ended");

    await this.db
      .update(chatHuddleParticipants)
      .set({ leftAt: new Date() })
      .where(and(eq(chatHuddleParticipants.huddleId, huddleId), eq(chatHuddleParticipants.userId, userId)));

    const remaining = await this.db.query.chatHuddleParticipants.findMany({
      where: and(eq(chatHuddleParticipants.huddleId, huddleId), isNull(chatHuddleParticipants.leftAt)),
    });

    if (remaining.length === 0) {
      const now = new Date();
      await this.db.update(chatHuddles).set({ status: "ended", endedAt: now }).where(eq(chatHuddles.id, huddleId));

      if (huddle.calendarEventId) {
        await this.db
          .update(calendarEvents)
          .set({ endDate: now })
          .where(eq(calendarEvents.id, huddle.calendarEventId));
      }

      await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:ended", { huddleId, channelId: huddle.channelId });
      this.audit.log({ action: "huddle.ended", userId, orgId, targetId: String(huddleId), targetType: "huddle" });
    } else {
      if (huddle.startedBy === userId && remaining.length > 0) {
        const nextHost = remaining[0];
        await this.db.update(chatHuddles).set({ startedBy: nextHost.userId }).where(eq(chatHuddles.id, huddleId));
        await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", {
          huddleId, hostTransferred: true, newHostId: nextHost.userId,
        });
      }
      await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:user_left", {
        huddleId,
        userId,
        channelId: huddle.channelId,
      });
      this.audit.log({ action: "huddle.left", userId, orgId, targetId: String(huddleId), targetType: "huddle" });
    }

    return { ok: true };
  }

  async setMute(huddleId: number, userId: string, muted: boolean, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, userId);

    await this.db
      .update(chatHuddleParticipants)
      .set({ isMuted: muted })
      .where(
        and(
          eq(chatHuddleParticipants.huddleId, huddleId),
          eq(chatHuddleParticipants.userId, userId),
          isNull(chatHuddleParticipants.leftAt),
        ),
      );

    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", { huddleId, userId, isMuted: muted });
    return { ok: true };
  }

  async setDeafen(huddleId: number, userId: string, orgId: string, deafened: boolean) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, userId);
    await this.db.update(chatHuddleParticipants).set({ isDeafened: deafened })
      .where(and(eq(chatHuddleParticipants.huddleId, huddleId), eq(chatHuddleParticipants.userId, userId)));
    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", { huddleId, userId, isDeafened: deafened });
    return { ok: true };
  }

  async raiseHand(huddleId: number, userId: string, raised: boolean, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, userId);

    await this.db
      .update(chatHuddleParticipants)
      .set({ handRaised: raised })
      .where(
        and(
          eq(chatHuddleParticipants.huddleId, huddleId),
          eq(chatHuddleParticipants.userId, userId),
          isNull(chatHuddleParticipants.leftAt),
        ),
      );

    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", { huddleId, userId, handRaised: raised });
    return { ok: true };
  }

  async sendSignal(huddleId: number, fromUserId: string, signal: HuddleSignalInput, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, fromUserId);

    await this.ably.publishHuddleSignal(orgId, huddle.channelId, signal.targetUserId, {
      fromUserId,
      type: signal.type,
      payload: signal.payload,
    });

    return { ok: true };
  }

  async startVideoMeeting(channelId: number, userId: string, orgId: string) {
    await this.assertMember(channelId, userId);

    const existing = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.channelId, channelId), eq(chatHuddles.status, "active")),
    });
    if (existing) {
      await this.joinHuddle(existing.id, userId, orgId);
      return existing;
    }

    const channel = await this.db.query.chatChannels.findFirst({
      where: eq(chatChannels.id, channelId),
      columns: { name: true },
    });

    const channelMembers = await this.db
      .select({ userId: chatChannelMembers.userId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.channelId, channelId));

    const now = new Date();
    const estimatedEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const huddle = await this.db.transaction(async (tx) => {
      const [calEvent] = await tx
        .insert(calendarEvents)
        .values({
          orgId,
          title: `Video Meeting in #${channel?.name ?? "channel"}`,
          category: "huddle",
          entityType: "huddle",
          entityId: channelId.toString(),
          startDate: now,
          endDate: estimatedEnd,
          allDay: false,
          attendeeIds: channelMembers.map((m) => m.userId),
          createdBy: userId,
        })
        .returning({ id: calendarEvents.id });

      const [created] = await tx
        .insert(chatHuddles)
        .values({ channelId, startedBy: userId, status: "active", calendarEventId: calEvent?.id, hasVideo: true })
        .returning();

      await tx.insert(chatHuddleParticipants).values({ huddleId: created.id, userId });

      return created;
    });

    await this.ably.publishMeetingEvent(orgId, channelId, "meeting:started", {
      huddleId: huddle.id,
      channelId,
      startedBy: userId,
    });

    return huddle;
  }

  async sendMeetingSignal(huddleId: number, fromUserId: string, orgId: string, targetUserId: string, type: string, payload: unknown) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, fromUserId);

    await this.ably.publishMeetingSignal(orgId, huddle.channelId, targetUserId, {
      fromUserId,
      type,
      payload,
    });

    return { ok: true };
  }

  async setCameraState(huddleId: number, userId: string, isCameraOff: boolean, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, userId);
    await this.db
      .update(chatHuddleParticipants)
      .set({ isCameraOff })
      .where(and(eq(chatHuddleParticipants.huddleId, huddleId), eq(chatHuddleParticipants.userId, userId), isNull(chatHuddleParticipants.leftAt)));
    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", { huddleId, userId, isCameraOff });
    return { ok: true };
  }

  async setScreenShare(huddleId: number, userId: string, isScreenSharing: boolean, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, userId);
    await this.db
      .update(chatHuddleParticipants)
      .set({ isScreenSharing })
      .where(and(eq(chatHuddleParticipants.huddleId, huddleId), eq(chatHuddleParticipants.userId, userId), isNull(chatHuddleParticipants.leftAt)));
    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", { huddleId, userId, isScreenSharing });
    return { ok: true };
  }

  async kickParticipant(huddleId: number, userId: string, targetUserId: string, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, userId);
    if (huddle.startedBy !== userId) throw new ForbiddenException("Only the huddle host can remove participants");
    await this.db
      .update(chatHuddleParticipants)
      .set({ leftAt: new Date() })
      .where(and(eq(chatHuddleParticipants.huddleId, huddleId), eq(chatHuddleParticipants.userId, targetUserId), isNull(chatHuddleParticipants.leftAt)));
    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", { huddleId, userId: targetUserId, kicked: true });
    void this.ably.publishToUser(orgId, targetUserId, "huddle:kicked", { huddleId, channelId: huddle.channelId }).catch(() => {});
    return { ok: true };
  }

  async inviteToHuddle(huddleId: number, fromUserId: string, orgId: string, targetUserIds: string[]) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, fromUserId);
    for (const userId of targetUserIds) {
      await this.ably.publishToUser(orgId, userId, "notification:huddle_invite", {
        huddleId,
        channelId: huddle.channelId,
        fromUserId,
      });
    }
    return { ok: true };
  }
}
