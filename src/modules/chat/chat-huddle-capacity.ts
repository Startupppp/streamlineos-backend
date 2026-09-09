/**
 * How many people may be in a huddle, and who decides.
 *
 * Two ceilings apply and the smaller wins: the plan (Free huddles are one-to-one) and the
 * organization's own `maxHuddleParticipants` setting. There is no longer a transport ceiling —
 * the call is a Google Meet room, not a peer-to-peer mesh — so the org setting is the operative
 * cap for the first time. It is clamped to the same 2..500 band `chatOrgSettingsResponseSchema`
 * and `updateChatSettingsSchema` validate, so a row written before those bounds existed cannot
 * declare an unbounded room or a room of zero. Someone already in the call is never refused
 * re-entry: a dropped connection reconnecting must not be told the room it is in is full.
 */
import { ForbiddenException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { chatHuddleParticipants } from "../../db/schema";
import type { Db } from "../../db/drizzle.types";
import type { ChatOrgSettingsService } from "./chat-org-settings.service";
import type { PlanLimitsService } from "../billing/core/plan-limits.service";
import {
  FREE_HUDDLE_MAX_PARTICIPANTS,
  FREE_HUDDLE_UPGRADE_MESSAGE,
  PLAN_FEATURE_FLAGS,
} from "../billing/core/plan-entitlements.constants";

export const HUDDLE_PARTICIPANT_FLOOR = 2;
export const HUDDLE_PARTICIPANT_CEILING = 500;

export interface HuddleCapacityDeps {
  db: Db;
  planLimits: PlanLimitsService;
  orgSettings: ChatOrgSettingsService;
}

export function clampHuddleCap(configured: number): number {
  if (!Number.isFinite(configured)) return HUDDLE_PARTICIPANT_FLOOR;
  return Math.min(
    Math.max(Math.trunc(configured), HUDDLE_PARTICIPANT_FLOOR),
    HUDDLE_PARTICIPANT_CEILING,
  );
}

export async function assertHuddleJoinCapacity(
  deps: HuddleCapacityDeps,
  orgId: string,
  huddleId: number,
  callerMembershipId: number,
): Promise<void> {
  const { tier } = await deps.planLimits.resolveTier(orgId);
  const { maxHuddleParticipants } = await deps.orgSettings.getSettings(orgId);
  const orgCap = clampHuddleCap(maxHuddleParticipants);
  const freeCapped = !PLAN_FEATURE_FLAGS[tier].chatGroupHuddles;
  const effectiveCap = freeCapped ? Math.min(orgCap, FREE_HUDDLE_MAX_PARTICIPANTS) : orgCap;

  const activeParticipants = await deps.db.query.chatHuddleParticipants.findMany({
    where: and(
      eq(chatHuddleParticipants.orgId, orgId),
      eq(chatHuddleParticipants.huddleId, huddleId),
      isNull(chatHuddleParticipants.leftAt),
    ),
    columns: { membershipId: true },
    limit: effectiveCap + 1,
  });
  if (activeParticipants.some((p) => p.membershipId === callerMembershipId)) return;

  if (freeCapped && activeParticipants.length >= FREE_HUDDLE_MAX_PARTICIPANTS)
    throw new ForbiddenException(FREE_HUDDLE_UPGRADE_MESSAGE);

  if (activeParticipants.length >= orgCap)
    throw new ForbiddenException(`This call is full (max ${orgCap} participants)`);
}

/**
 * An invitation is refused on the Free plan for the same reason a join is, but the count is read
 * only when the plan actually caps it — a paid org never pays for the query.
 */
export async function assertHuddleInviteCapacity(
  deps: HuddleCapacityDeps,
  orgId: string,
  huddleId: number,
): Promise<void> {
  const { tier } = await deps.planLimits.resolveTier(orgId);
  if (PLAN_FEATURE_FLAGS[tier].chatGroupHuddles) return;
  const activeParticipants = await deps.db.query.chatHuddleParticipants.findMany({
    where: and(eq(chatHuddleParticipants.huddleId, huddleId), isNull(chatHuddleParticipants.leftAt)),
    columns: { id: true },
    limit: FREE_HUDDLE_MAX_PARTICIPANTS + 1,
  });
  if (activeParticipants.length >= FREE_HUDDLE_MAX_PARTICIPANTS)
    throw new ForbiddenException(FREE_HUDDLE_UPGRADE_MESSAGE);
}
