import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
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
import { AuditService } from "../../common/audit/audit.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  PLAN_FEATURE_FLAGS,
  FREE_HUDDLE_MAX_PARTICIPANTS,
  FREE_HUDDLE_UPGRADE_MESSAGE,
  HUDDLE_MESH_MAX_PARTICIPANTS,
} from "../billing/core/plan-entitlements.constants";
import { flattenChannelMember } from "./chat-channel-member-shape";
export { HUDDLE_MESH_MAX_PARTICIPANTS };

/** Huddle columns that reach the client. `orgId` and `startedByMembershipId` deliberately do not. */
export const HUDDLE_WIRE_COLUMNS = {
  id: true,
  channelId: true,
  status: true,
  calendarEventId: true,
  startedAt: true,
  endedAt: true,
} as const;

/** Participant columns that reach the client. `orgId` and `membershipId` deliberately do not. */
export const HUDDLE_PARTICIPANT_WIRE_COLUMNS = {
  id: true,
  huddleId: true,
  joinedAt: true,
  leftAt: true,
  isMuted: true,
  handRaised: true,
  isScreenSharing: true,
} as const;

/** Every key a huddle carries on the wire, and nothing else. */
export const HUDDLE_WIRE_KEYS = [
  "calendarEventId",
  "channelId",
  "endedAt",
  "id",
  "participants",
  "startedAt",
  "startedBy",
  "startedByUser",
  "status",
] as const;

/** Every key a huddle participant carries on the wire, and nothing else. */
export const HUDDLE_PARTICIPANT_WIRE_KEYS = [
  "handRaised",
  "huddleId",
  "id",
  "isMuted",
  "isScreenSharing",
  "joinedAt",
  "leftAt",
  "user",
  "userId",
] as const;

@Injectable()
export class ChatHuddlesService {
  private readonly logger = new Logger(ChatHuddlesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
    private readonly audit: AuditService,
    private readonly orgSettings: ChatOrgSettingsService,
    private readonly planLimits: PlanLimitsService,
    private readonly dispatch: NotificationDispatchService,
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

  async getActiveHuddle(channelId: number, userId: string, orgId: string) {
    await this.assertMember(channelId, userId, orgId);
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(
        eq(chatHuddles.orgId, orgId),
        eq(chatHuddles.channelId, channelId),
        eq(chatHuddles.status, "active"),
      ),
      columns: { id: true, channelId: true, startedByMembershipId: true, status: true, calendarEventId: true, startedAt: true, endedAt: true, hasVideo: true },
    });
    if (!huddle) return null;

    if (huddle.endedAt) {
      await this.db
        .update(chatHuddles)
        .set({ status: "ended" })
        .where(and(eq(chatHuddles.orgId, orgId), eq(chatHuddles.id, huddle.id)));
      return null;
    }

    const staleThreshold = new Date(Date.now() - 90_000);
    await this.db
      .update(chatHuddleParticipants)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(chatHuddleParticipants.orgId, orgId),
          eq(chatHuddleParticipants.huddleId, huddle.id),
          isNull(chatHuddleParticipants.leftAt),
          lt(chatHuddleParticipants.lastSeenAt, staleThreshold),
          lt(chatHuddleParticipants.joinedAt, staleThreshold),
        ),
      );

    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const remaining = await this.db.query.chatHuddleParticipants.findMany({
      where: and(
        eq(chatHuddleParticipants.orgId, orgId),
        eq(chatHuddleParticipants.huddleId, huddle.id),
        isNull(chatHuddleParticipants.leftAt),
      ),
      columns: { id: true },
      limit: 1,
    });

    if (remaining.length === 0 || huddle.startedAt < twelveHoursAgo) {
      const now = new Date();
      await this.db.update(chatHuddles).set({ status: "ended", endedAt: now }).where(and(eq(chatHuddles.orgId, orgId), eq(chatHuddles.id, huddle.id)));
      if (huddle.calendarEventId) {
        await this.db.update(calendarEvents).set({ endDate: now }).where(and(eq(calendarEvents.orgId, orgId), eq(calendarEvents.id, huddle.calendarEventId)));
      }
      await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:ended", { huddleId: huddle.id, channelId: huddle.channelId });
      return null;
    }

    return this.loadHuddleWire(huddle.id, orgId);
  }

  /**
   * The one wire shape a huddle is read in, by every route that returns one.
   *
   * `chat_huddle_participants` reaches a person only through `organization_members`, and this read
   * used to ship that join verbatim as `participants[].membership.user` while the client's
   * `HuddleParticipant` declared `user` and `userId` at the top level — and
   * `apiClient.get<Huddle | null>` is a cast, so the compiler vouched for a shape the API had never
   * sent. `membership.columns` was additionally `{}`, so `userId` was not even selected: every tile
   * and every screenshare label read "Unknown", `isInHuddle` was permanently false so the huddle
   * panel never rendered, and the WebRTC mesh had no peer ids to dial.
   *
   * The join is flattened by the same `flattenChannelMember` the channel-member routes use, so the
   * two member shapes in chat are one shape. `startedByMembership` becomes `startedByUser`, and
   * `startedBy` carries the host's USER id — the client compares it to its own user id, and the
   * membership id it used to receive could never match. `orgId`, `membershipId` and
   * `startedByMembershipId` leave the wire with them: internal join keys the client never read.
   */
  private async loadHuddleWire(huddleId: number, orgId: string) {
    const row = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.orgId, orgId), eq(chatHuddles.id, huddleId)),
      columns: HUDDLE_WIRE_COLUMNS,
      with: {
        participants: {
          where: isNull(chatHuddleParticipants.leftAt),
          columns: HUDDLE_PARTICIPANT_WIRE_COLUMNS,
          with: {
            membership: {
              columns: { userId: true },
              with: {
                user: { columns: { id: true, name: true, image: true } },
              },
            },
          },
        },
        startedByMembership: {
          columns: { userId: true },
          with: {
            user: { columns: { id: true, name: true } },
          },
        },
      },
    });
    if (!row) return null;
    const { startedByMembership, participants, ...huddle } = row;
    return {
      ...huddle,
      startedBy: startedByMembership?.userId ?? null,
      startedByUser: startedByMembership?.user ?? null,
      participants: participants.map(flattenChannelMember),
    };
  }

  async startHuddle(channelId: number, userId: string, orgId: string) {
    const starterMembershipId = await this.assertMember(channelId, userId, orgId);

    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
      columns: { name: true },
    });

    const now = new Date();
    const estimatedEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    let isNewHuddle = false;
    const huddle = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${orgId} || ':huddle:' || ${channelId}::text)::bigint)`,
      );

      const existing = await tx.query.chatHuddles.findFirst({
        where: and(
          eq(chatHuddles.orgId, orgId),
          eq(chatHuddles.channelId, channelId),
          eq(chatHuddles.status, "active"),
        ),
      });
      if (existing) {
        await tx
          .insert(chatHuddleParticipants)
          .values({ orgId, huddleId: existing.id, membershipId: starterMembershipId })
          .onConflictDoUpdate({
            target: [chatHuddleParticipants.huddleId, chatHuddleParticipants.membershipId],
            set: { leftAt: null, joinedAt: new Date(), isMuted: false, handRaised: false, lastSeenAt: new Date() },
          });
        return existing;
      }
      isNewHuddle = true;

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

      if (calEvent) {
        const ATTENDEE_BATCH = 500;
        let afterMembershipId: number | null = null;
        for (;;) {
          const batch = await tx
            .select({ membershipId: chatChannelMembers.membershipId })
            .from(chatChannelMembers)
            .where(
              and(
                eq(chatChannelMembers.orgId, orgId),
                eq(chatChannelMembers.channelId, channelId),
                afterMembershipId !== null ? gt(chatChannelMembers.membershipId, afterMembershipId) : undefined,
              ),
            )
            .orderBy(asc(chatChannelMembers.membershipId))
            .limit(ATTENDEE_BATCH);
          if (batch.length === 0) break;
          await tx
            .insert(eventAttendees)
            .values(batch.map((b) => ({ orgId, eventId: calEvent.id, membershipId: b.membershipId })))
            .onConflictDoNothing();
          if (batch.length < ATTENDEE_BATCH) break;
          afterMembershipId = batch[batch.length - 1]?.membershipId ?? afterMembershipId;
          if (afterMembershipId === null) break;
        }
      }

      const [created] = await tx
        .insert(chatHuddles)
        .values({
          orgId,
          channelId,
          startedByMembershipId: starterMembershipId,
          status: "active",
          calendarEventId: calEvent?.id,
          hasVideo: false,
        })
        .returning();

      await tx.insert(chatHuddleParticipants).values({
        orgId,
        huddleId: created.id,
        membershipId: starterMembershipId,
      });

      return created;
    });

    if (isNewHuddle) {
      await this.ably.publishHuddleEvent(orgId, channelId, "huddle:started", {
        huddleId: huddle.id,
        channelId,
        startedBy: userId,
      });

      this.audit.log({
        action: "huddle.started",
        userId,
        orgId,
        targetId: String(huddle.id),
        targetType: "huddle",
        metadata: { channelId },
      });

      const NOTIFY_BATCH = 500;
      const targetUserIds: string[] = [];
      let afterMembershipId: number | null = null;
      for (;;) {
        const batch = await this.db
          .select({ userId: organizationMembers.userId, membershipId: chatChannelMembers.membershipId })
          .from(chatChannelMembers)
          .innerJoin(organizationMembers, eq(organizationMembers.id, chatChannelMembers.membershipId))
          .where(
            and(
              eq(chatChannelMembers.orgId, orgId),
              eq(chatChannelMembers.channelId, channelId),
              afterMembershipId !== null ? gt(chatChannelMembers.membershipId, afterMembershipId) : undefined,
            ),
          )
          .orderBy(asc(chatChannelMembers.membershipId))
          .limit(NOTIFY_BATCH);
        for (const row of batch)
          if (row.userId !== userId) targetUserIds.push(row.userId);
        if (batch.length < NOTIFY_BATCH) break;
        afterMembershipId = batch[batch.length - 1]?.membershipId ?? afterMembershipId;
        if (afterMembershipId === null) break;
      }

      if (targetUserIds.length > 0) {
        await this.dispatch.emit({
          eventKey: "chat.huddle.invite",
          orgId,
          actorUserId: userId,
          targetUserIds,
          entityType: "channel",
          entityId: String(channelId),
          title: `Huddle started in #${channel?.name ?? "channel"}`,
          message: "A huddle has started — tap to join.",
          link: `/chat?channel=${channelId}&joinHuddle=1`,
          variables: { channelId, huddleId: huddle.id },
        });
      }
    }

    return this.loadHuddleWire(huddle.id, orgId);
  }

  async joinHuddle(huddleId: number, userId: string, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found or already ended");

    const callerMembershipId = await this.assertMember(huddle.channelId, userId, orgId);

    const activeParticipants = await this.db.query.chatHuddleParticipants.findMany({
      where: and(
        eq(chatHuddleParticipants.orgId, orgId),
        eq(chatHuddleParticipants.huddleId, huddleId),
        isNull(chatHuddleParticipants.leftAt),
      ),
      columns: { membershipId: true },
      limit: HUDDLE_MESH_MAX_PARTICIPANTS + 1,
    });
    const alreadyActive = activeParticipants.some((p) => p.membershipId === callerMembershipId);
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

    await this.db
      .insert(chatHuddleParticipants)
      .values({ orgId, huddleId, membershipId: callerMembershipId })
      .onConflictDoUpdate({
        target: [chatHuddleParticipants.huddleId, chatHuddleParticipants.membershipId],
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

    const callerMembership = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
      columns: { id: true },
    });

    if (callerMembership) {
      await this.db
        .update(chatHuddleParticipants)
        .set({ leftAt: new Date() })
        .where(
          and(
            eq(chatHuddleParticipants.orgId, orgId),
            eq(chatHuddleParticipants.huddleId, huddleId),
            eq(chatHuddleParticipants.membershipId, callerMembership.id),
          ),
        );
    }

    const remaining = await this.db.query.chatHuddleParticipants.findMany({
      where: and(
        eq(chatHuddleParticipants.orgId, orgId),
        eq(chatHuddleParticipants.huddleId, huddleId),
        isNull(chatHuddleParticipants.leftAt),
      ),
      columns: { membershipId: true },
      limit: 1,
    });

    if (remaining.length === 0) {
      const now = new Date();
      await this.db.update(chatHuddles).set({ status: "ended", endedAt: now }).where(and(eq(chatHuddles.orgId, orgId), eq(chatHuddles.id, huddleId)));

      if (huddle.calendarEventId) {
        await this.db
          .update(calendarEvents)
          .set({ endDate: now })
          .where(
            and(eq(calendarEvents.orgId, orgId), eq(calendarEvents.id, huddle.calendarEventId)),
          );
      }

      await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:ended", { huddleId, channelId: huddle.channelId });
      this.audit.log({ action: "huddle.ended", userId, orgId, targetId: String(huddleId), targetType: "huddle" });
    } else {
      if (huddle.startedByMembershipId === callerMembership?.id) {
        const nextHost = remaining[0];
        if (nextHost) {
          await this.db.update(chatHuddles).set({ startedByMembershipId: nextHost.membershipId }).where(and(eq(chatHuddles.orgId, orgId), eq(chatHuddles.id, huddleId)));
          await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", {
            huddleId, hostTransferred: true, newHostMembershipId: nextHost.membershipId,
          });
        }
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

  async kickParticipant(huddleId: number, userId: string, targetUserId: string, orgId: string) {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    const callerMembershipId = await this.assertMember(huddle.channelId, userId, orgId);
    if (huddle.startedByMembershipId !== callerMembershipId) throw new ForbiddenException("Only the huddle host can remove participants");
    const targetMembership = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)),
      columns: { id: true },
    });
    if (targetMembership) {
      await this.db
        .update(chatHuddleParticipants)
        .set({ leftAt: new Date() })
        .where(
          and(
            eq(chatHuddleParticipants.orgId, orgId),
            eq(chatHuddleParticipants.huddleId, huddleId),
            eq(chatHuddleParticipants.membershipId, targetMembership.id),
            isNull(chatHuddleParticipants.leftAt),
          ),
        );
    }
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
        columns: { id: true },
        limit: FREE_HUDDLE_MAX_PARTICIPANTS + 1,
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
