import { ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { chatChannels, chatHuddleParticipants, chatHuddles } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import { AuditService } from "../../common/audit/audit.service";
import { ChatOrgSettingsService } from "./chat-org-settings.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  assertHuddleChannelMember,
  requireActiveHuddle,
  resolveMembershipIdAnyStatus,
} from "./chat-huddle-access";
import { assertHuddleInviteCapacity, assertHuddleJoinCapacity, type HuddleCapacityDeps } from "./chat-huddle-capacity";
import { createHuddleCalendarEvent } from "./chat-huddle-calendar";
import {
  HUDDLE_MAX_DURATION_MS,
  endHuddle,
  findRemainingParticipant,
  markHuddleEnded,
  markParticipantLeft,
  reapStaleHuddleParticipants,
  transferHuddleHost,
  upsertHuddleParticipant,
} from "./chat-huddle-lifecycle";
import { notifyHuddleStarted } from "./chat-huddle-notifications";
import { loadHuddleWire } from "./chat-huddle-wire-shape";

/** A started huddle books two hours of calendar; the real end time replaces it when the call ends. */
const HUDDLE_ESTIMATED_DURATION_MS = 2 * 60 * 60 * 1000;

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

  private capacityDeps(): HuddleCapacityDeps {
    return { db: this.db, planLimits: this.planLimits, orgSettings: this.orgSettings };
  }

  private assertMember(channelId: number, userId: string, orgId: string): Promise<number> {
    return assertHuddleChannelMember(this.db, channelId, userId, orgId);
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
      await markHuddleEnded(this.db, orgId, huddle.id);
      return null;
    }

    await reapStaleHuddleParticipants(this.db, orgId, huddle.id);

    const remaining = await findRemainingParticipant(this.db, orgId, huddle.id);
    const expiredAt = new Date(Date.now() - HUDDLE_MAX_DURATION_MS);
    if (!remaining || huddle.startedAt < expiredAt) {
      await endHuddle(this.db, this.ably, orgId, huddle);
      return null;
    }

    return loadHuddleWire(this.db, huddle.id, orgId);
  }

  async startHuddle(channelId: number, userId: string, orgId: string) {
    const starterMembershipId = await this.assertMember(channelId, userId, orgId);

    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
      columns: { name: true },
    });
    const channelName = channel?.name ?? "channel";

    const now = new Date();
    const estimatedEndsAt = new Date(now.getTime() + HUDDLE_ESTIMATED_DURATION_MS);

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
        await upsertHuddleParticipant(tx, orgId, existing.id, starterMembershipId);
        return existing;
      }
      isNewHuddle = true;

      const calendarEventId = await createHuddleCalendarEvent(tx, {
        orgId,
        channelId,
        channelName,
        starterMembershipId,
        startsAt: now,
        estimatedEndsAt,
      });

      const [created] = await tx
        .insert(chatHuddles)
        .values({
          orgId,
          channelId,
          startedByMembershipId: starterMembershipId,
          status: "active",
          calendarEventId,
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

      await notifyHuddleStarted(this.db, this.dispatch, {
        orgId,
        channelId,
        channelName,
        huddleId: huddle.id,
        actorUserId: userId,
      });
    }

    return loadHuddleWire(this.db, huddle.id, orgId);
  }

  async joinHuddle(huddleId: number, userId: string, orgId: string) {
    const huddle = await requireActiveHuddle(this.db, huddleId, orgId, "Huddle not found or already ended");
    const callerMembershipId = await this.assertMember(huddle.channelId, userId, orgId);

    await assertHuddleJoinCapacity(this.capacityDeps(), orgId, huddleId, callerMembershipId);
    await upsertHuddleParticipant(this.db, orgId, huddleId, callerMembershipId);

    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:user_joined", {
      huddleId,
      userId,
      channelId: huddle.channelId,
    });

    this.audit.log({ action: "huddle.joined", userId, orgId, targetId: String(huddleId), targetType: "huddle" });

    return { ok: true };
  }

  async leaveHuddle(huddleId: number, userId: string, orgId: string) {
    const huddle = await requireActiveHuddle(this.db, huddleId, orgId, "Huddle not found or already ended");

    const callerMembershipId = await resolveMembershipIdAnyStatus(this.db, orgId, userId);
    if (callerMembershipId !== null) await markParticipantLeft(this.db, orgId, huddleId, callerMembershipId);

    const remaining = await findRemainingParticipant(this.db, orgId, huddleId);

    if (!remaining) {
      await endHuddle(this.db, this.ably, orgId, { id: huddleId, channelId: huddle.channelId, calendarEventId: huddle.calendarEventId });
      this.audit.log({ action: "huddle.ended", userId, orgId, targetId: String(huddleId), targetType: "huddle" });
      return { ok: true };
    }

    if (callerMembershipId !== null && huddle.startedByMembershipId === callerMembershipId)
      await transferHuddleHost(this.db, this.ably, orgId, { id: huddleId, channelId: huddle.channelId }, remaining.membershipId);

    await this.ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:user_left", {
      huddleId,
      userId,
      channelId: huddle.channelId,
    });
    this.audit.log({ action: "huddle.left", userId, orgId, targetId: String(huddleId), targetType: "huddle" });

    return { ok: true };
  }

  async kickParticipant(huddleId: number, userId: string, targetUserId: string, orgId: string) {
    const huddle = await requireActiveHuddle(this.db, huddleId, orgId, "Huddle not found");
    const callerMembershipId = await this.assertMember(huddle.channelId, userId, orgId);
    if (huddle.startedByMembershipId !== callerMembershipId) throw new ForbiddenException("Only the huddle host can remove participants");

    const targetMembershipId = await resolveMembershipIdAnyStatus(this.db, orgId, targetUserId);
    if (targetMembershipId !== null)
      await markParticipantLeft(this.db, orgId, huddleId, targetMembershipId, { onlyIfStillActive: true });

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
    const huddle = await requireActiveHuddle(this.db, huddleId, orgId, "Huddle not found");
    await this.assertMember(huddle.channelId, fromUserId, orgId);

    await assertHuddleInviteCapacity(this.capacityDeps(), orgId, huddleId);

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
