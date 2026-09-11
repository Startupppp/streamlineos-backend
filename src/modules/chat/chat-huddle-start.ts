/**
 * Starting a huddle, in three phases with the third-party call in the middle.
 *
 * A huddle's transport is a Google Meet room, minted through the org's Composio connection at
 * start and returned in the start response, so the start path makes a network call that a
 * pooled connection must not wait on. The controller carries `@NoTenantTransaction()` and the
 * two database phases open their own tenant transactions around the mint: reads and the rejoin
 * short-circuit first, then Google, then the writes. If Google refuses, phase three never runs
 * and no huddle row exists — a huddle is never started without a way into it.
 *
 * Two starts racing both mint a link; the loser's advisory-lock re-check finds the winner's
 * huddle and returns it, abandoning an unused Meet room. That is the cheap side of the trade:
 * the alternative is holding the lock across the provider round trip.
 */
import { and, eq, sql } from "drizzle-orm";
import { chatChannels, chatHuddleParticipants, chatHuddles } from "../../db/schema";
import type { Db } from "../../db/drizzle.types";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import type { AblyService } from "../realtime/ably.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { ComposioGateway } from "../integrations/core/composio.gateway";
import type { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { assertHuddleChannelMember } from "./chat-huddle-access";
import { createHuddleCalendarEvent } from "./chat-huddle-calendar";
import {
  mintHuddleMeetingUrl,
  resolveHuddleMeetingConnection,
  type HuddleMeetingConnection,
} from "./chat-huddle-meeting";
import { upsertHuddleParticipant } from "./chat-huddle-lifecycle";
import { notifyHuddleStarted } from "./chat-huddle-notifications";
import { loadHuddleWire } from "./chat-huddle-wire-shape";

/** A started huddle books two hours of calendar; the real end time replaces it when the call ends. */
export const HUDDLE_ESTIMATED_DURATION_MS = 2 * 60 * 60 * 1000;

export type HuddleWire = Awaited<ReturnType<typeof loadHuddleWire>>;

export interface HuddleStartDeps {
  db: Db;
  ably: AblyService;
  audit: AuditService;
  dispatch: NotificationDispatchService;
  composio: ComposioGateway;
}

type StartPreparation =
  | { kind: "rejoined"; wire: HuddleWire }
  | {
      kind: "new";
      starterMembershipId: number;
      channelName: string;
      connection: HuddleMeetingConnection;
    };

async function prepareStart(
  deps: HuddleStartDeps,
  channelId: number,
  userId: string,
  orgId: string,
): Promise<StartPreparation> {
  const starterMembershipId = await assertHuddleChannelMember(deps.db, channelId, userId, orgId);

  const existing = await deps.db.query.chatHuddles.findFirst({
    where: and(
      eq(chatHuddles.orgId, orgId),
      eq(chatHuddles.channelId, channelId),
      eq(chatHuddles.status, "active"),
    ),
    columns: { id: true },
  });
  if (existing) {
    await upsertHuddleParticipant(deps.db, orgId, existing.id, starterMembershipId);
    return { kind: "rejoined", wire: await loadHuddleWire(deps.db, existing.id, orgId) };
  }

  const channel = await deps.db.query.chatChannels.findFirst({
    where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
    columns: { name: true },
  });
  const connection = await resolveHuddleMeetingConnection(
    deps.db,
    orgId,
    userId,
    starterMembershipId,
  );
  return { kind: "new", starterMembershipId, channelName: channel?.name ?? "channel", connection };
}

async function commitStart(
  deps: HuddleStartDeps,
  channelId: number,
  userId: string,
  orgId: string,
  prepared: Extract<StartPreparation, { kind: "new" }>,
  meetingUrl: string,
  startsAt: Date,
): Promise<HuddleWire> {
  const { starterMembershipId, channelName } = prepared;
  const estimatedEndsAt = new Date(startsAt.getTime() + HUDDLE_ESTIMATED_DURATION_MS);

  let isNewHuddle = false;
  const huddle = await deps.db.transaction(async (tx) => {
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
      startsAt,
      estimatedEndsAt,
      meetingUrl,
    });

    const [created] = await tx
      .insert(chatHuddles)
      .values({
        orgId,
        channelId,
        startedByMembershipId: starterMembershipId,
        status: "active",
        calendarEventId,
        meetingUrl,
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
    await deps.ably.publishHuddleEvent(orgId, channelId, "huddle:started", {
      huddleId: huddle.id,
      channelId,
      startedBy: userId,
    });

    deps.audit.log({
      action: "huddle.started",
      userId,
      orgId,
      targetId: String(huddle.id),
      targetType: "huddle",
      metadata: { channelId },
    });

    await notifyHuddleStarted(deps.db, deps.dispatch, {
      orgId,
      channelId,
      channelName,
      huddleId: huddle.id,
      actorUserId: userId,
    });
  }

  return loadHuddleWire(deps.db, huddle.id, orgId);
}

export async function startHuddleWithMeeting(
  deps: HuddleStartDeps,
  channelId: number,
  userId: string,
  orgId: string,
): Promise<HuddleWire> {
  const startsAt = new Date();
  const prepared = await runInNewTenantTransaction(deps.db, orgId, () =>
    prepareStart(deps, channelId, userId, orgId),
  );
  if (prepared.kind === "rejoined") return prepared.wire;

  const meetingUrl = await mintHuddleMeetingUrl(deps.composio, prepared.connection, {
    channelName: prepared.channelName,
    startsAt,
    estimatedEndsAt: new Date(startsAt.getTime() + HUDDLE_ESTIMATED_DURATION_MS),
  });

  return runInNewTenantTransaction(deps.db, orgId, () =>
    commitStart(deps, channelId, userId, orgId, prepared, meetingUrl, startsAt),
  );
}
