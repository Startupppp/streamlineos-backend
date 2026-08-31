import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import {
  calendarEvents,
  chatChannelMembers,
  chatChannels,
  chatHuddleParticipants,
  chatHuddles,
  eventAttendees,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import { WebPushService } from "../realtime/web-push.service";
import { AuditService } from "../../common/audit/audit.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import {
  PLAN_FEATURE_FLAGS,
  FREE_HUDDLE_MAX_PARTICIPANTS,
  FREE_HUDDLE_UPGRADE_MESSAGE,
  HUDDLE_MESH_MAX_PARTICIPANTS,
} from "../billing/core/plan-entitlements.constants";
import type { HuddleSignalInput } from "./dto/huddle.schemas";

export { HUDDLE_MESH_MAX_PARTICIPANTS };

@Injectable()
export class ChatHuddlesService {
  private readonly logger = new Logger(ChatHuddlesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
    private readonly webPush: WebPushService,
    private readonly audit: AuditService,
    private readonly orgSettings: ChatOrgSettingsService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  private async assertMember(channelId: number, userId: string, orgId: string) {
    const activeMembership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!activeMembership) throw new ForbiddenException("Your membership is no longer active");
    const member = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, activeMembership.id),
      ),
    });
    if (!member) throw new ForbiddenException("You are not a member of this channel");
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
      columns: { isArchived: true },
    });
    if (channel?.isArchived) throw new ForbiddenException("Channel is archived");
    return member;
  }

  async getActiveHuddle(channelId: number, userId: string, orgId: string) {
    await this.assertMember(channelId, userId, orgId);
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.channelId, channelId), eq(chatHuddles.status, "active")),
      columns: { id: true, channelId: true, startedBy: true, status: true, calendarEventId: true, startedAt: true, endedAt: true, hasVideo: true },
    });
    if (!huddle) return null;

    if (huddle.endedAt) {
      await this.db.update(chatHuddles).set({ status: "ended" }).where(eq(chatHuddles.id, huddle.id));
      return null;
    }

    const staleThreshold = new Date(Date.now() - 90_000);
    await this.db
      .update(chatHuddleParticipants)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(chatHuddleParticipants.huddleId, huddle.id),
          isNull(chatHuddleParticipants.leftAt),
          lt(chatHuddleParticipants.lastSeenAt, staleThreshold),
          lt(chatHuddleParticipants.joinedAt, staleThreshold),
        ),
      );

    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const remaining = await this.db.query.chatHuddleParticipants.findMany({
      where: and(eq(chatHuddleParticipants.huddleId, huddle.id), isNull(chatHuddleParticipants.leftAt)),
      columns: { userId: true },
    });

    if (remaining.length === 0 || huddle.startedAt < twelveHoursAgo) {
      const now = new Date();
      await this.db.update(chatHuddles).set({ status: "ended", endedAt: now }).where(eq(chatHuddles.id, huddle.id));
      if (huddle.calendarEventId) {
        await this.db.update(calendarEvents).set({ endDate: now }).where(eq(calendarEvents.id, huddle.calendarEventId));
      }
      await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:ended", { huddleId: huddle.id, channelId: huddle.channelId });
      return null;
    }

    return this.db.query.chatHuddles.findFirst({
      where: eq(chatHuddles.id, huddle.id),
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
  }

  async startHuddle(channelId: number, userId: string, orgId: string) {
    await this.assertMember(channelId, userId, orgId);

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
      .select({ userId: organizationMembers.userId, membershipId: chatChannelMembers.membershipId })
      .from(chatChannelMembers)
      .innerJoin(organizationMembers, eq(organizationMembers.id, chatChannelMembers.membershipId))
      .where(and(eq(chatChannelMembers.orgId, orgId), eq(chatChannelMembers.channelId, channelId)));

    const starterMembershipId = channelMembers.find((m) => m.userId === userId)?.membershipId ?? null;
    if (!starterMembershipId) throw new BadRequestException("Active membership required to start a huddle");

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
          createdByMembershipId: starterMembershipId,
        })
        .returning({ id: calendarEvents.id });
      if (calEvent && channelMembers.length > 0) {
        await tx.insert(eventAttendees).values(channelMembers.map((member) => ({
          orgId,
          eventId: calEvent.id,
          membershipId: member.membershipId,
        })));
      }


      const [created] = await tx
        .insert(chatHuddles)
        .values({ orgId, channelId, startedBy: userId, startedByMembershipId: starterMembershipId, status: "active", calendarEventId: calEvent?.id, hasVideo: false })
        .returning();

      await tx.insert(chatHuddleParticipants).values({ orgId, huddleId: created.id, userId, membershipId: starterMembershipId });

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
        }).catch((error: unknown) => {
          this.logger.warn("ably: failed to notify user of huddle start", {
            orgId,
            channelId,
            huddleId: huddle.id,
            targetUserId: member.userId,
            error: error instanceof Error ? error.message : String(error),
            cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
          });
        });
      }
    }

    this.audit.log({ action: "huddle.started", userId, orgId, targetId: String(huddle.id), targetType: "huddle", metadata: { channelId } });

    for (const member of channelMembers) {
      if (member.userId !== userId) {
        void this.webPush.sendToUser(member.userId, {
          category: "CHAT",
          url: `/chat?channel=${channelId}&joinHuddle=1`,
        }).catch((error: unknown) => {
          this.logger.warn("web-push: failed to send huddle start notification", {
            orgId,
            channelId,
            huddleId: huddle.id,
            targetUserId: member.userId,
            error: error instanceof Error ? error.message : String(error),
            cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
          });
        });
      }
    }

    return huddle;
  }

  async joinHuddle(huddleId: number, userId: string, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found or already ended");

    await this.assertMember(huddle.channelId, userId, orgId);

    const activeParticipants = await this.db.query.chatHuddleParticipants.findMany({
      where: and(eq(chatHuddleParticipants.huddleId, huddleId), isNull(chatHuddleParticipants.leftAt)),
      columns: { userId: true },
    });
    const alreadyActive = activeParticipants.some((p) => p.userId === userId);
    if (!alreadyActive) {
      const { tier } = await this.planLimits.resolveTier(orgId);
      if (!PLAN_FEATURE_FLAGS[tier].chatGroupHuddles && activeParticipants.length >= FREE_HUDDLE_MAX_PARTICIPANTS) {
        throw new ForbiddenException(FREE_HUDDLE_UPGRADE_MESSAGE);
      }
      const { maxHuddleParticipants } = await this.orgSettings.getSettings(orgId);
      const effectiveCap = Math.min(maxHuddleParticipants, HUDDLE_MESH_MAX_PARTICIPANTS);
      if (activeParticipants.length >= effectiveCap) {
        throw new ForbiddenException(
          `This call is full (max ${effectiveCap} participants)`,
        );
      }
    }

    const joinerMembership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });

    await this.db
      .insert(chatHuddleParticipants)
      .values({ orgId, huddleId, userId, membershipId: joinerMembership?.id ?? null })
      .onConflictDoUpdate({
        target: [chatHuddleParticipants.huddleId, chatHuddleParticipants.userId],
        set: { leftAt: null, joinedAt: new Date(), isMuted: false, handRaised: false, lastSeenAt: new Date() },
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
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
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
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, userId, orgId);

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
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, userId, orgId);
    await this.db.update(chatHuddleParticipants).set({ isDeafened: deafened })
      .where(and(eq(chatHuddleParticipants.huddleId, huddleId), eq(chatHuddleParticipants.userId, userId)));
    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", { huddleId, userId, isDeafened: deafened });
    return { ok: true };
  }

  async raiseHand(huddleId: number, userId: string, raised: boolean, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, userId, orgId);

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
    await this.db
      .update(chatHuddleParticipants)
      .set({ lastSeenAt: sql`now()` })
      .where(
        and(
          eq(chatHuddleParticipants.orgId, orgId),
          eq(chatHuddleParticipants.huddleId, huddleId),
          eq(chatHuddleParticipants.userId, userId),
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
    await this.assertMember(huddle.channelId, userId, orgId);
    await this.db
      .update(chatHuddleParticipants)
      .set({ isScreenSharing })
      .where(and(eq(chatHuddleParticipants.huddleId, huddleId), eq(chatHuddleParticipants.userId, userId), isNull(chatHuddleParticipants.leftAt)));
    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", { huddleId, userId, isScreenSharing });
    return { ok: true };
  }

  async kickParticipant(huddleId: number, userId: string, targetUserId: string, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, userId, orgId);
    if (huddle.startedBy !== userId) throw new ForbiddenException("Only the huddle host can remove participants");
    await this.db
      .update(chatHuddleParticipants)
      .set({ leftAt: new Date() })
      .where(and(eq(chatHuddleParticipants.huddleId, huddleId), eq(chatHuddleParticipants.userId, targetUserId), isNull(chatHuddleParticipants.leftAt)));
    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", { huddleId, userId: targetUserId, kicked: true });
    void this.ably.publishToUser(orgId, targetUserId, "huddle:kicked", { huddleId, channelId: huddle.channelId }).catch((error: unknown) => {
      this.logger.warn("ably: failed to notify kicked participant", {
        orgId,
        channelId: huddle.channelId,
        huddleId,
        targetUserId,
        error: error instanceof Error ? error.message : String(error),
        cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
      });
    });
    return { ok: true };
  }

  async inviteToHuddle(huddleId: number, fromUserId: string, orgId: string, targetUserIds: string[]) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    await this.assertMember(huddle.channelId, fromUserId, orgId);

    const { tier } = await this.planLimits.resolveTier(orgId);
    if (!PLAN_FEATURE_FLAGS[tier].chatGroupHuddles) {
      const activeParticipants = await this.db.query.chatHuddleParticipants.findMany({
        where: and(eq(chatHuddleParticipants.huddleId, huddleId), isNull(chatHuddleParticipants.leftAt)),
        columns: { userId: true },
      });
      if (activeParticipants.length >= FREE_HUDDLE_MAX_PARTICIPANTS) {
        throw new ForbiddenException(FREE_HUDDLE_UPGRADE_MESSAGE);
      }
    }

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
