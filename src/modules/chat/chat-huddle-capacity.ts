/**
 * How many people may be in a huddle, and who decides.
 *
 * Three ceilings apply at once and the smallest wins: the plan (Free huddles are one-to-one), the
 * organization's own `maxHuddleParticipants` setting, and `HUDDLE_MESH_MAX_PARTICIPANTS` — a hard
 * technical bound, because the call is a full peer-to-peer mesh and an eleventh participant costs
 * every other browser another pair of streams. Someone already in the call is never refused
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
  HUDDLE_MESH_MAX_PARTICIPANTS,
  PLAN_FEATURE_FLAGS,
} from "../billing/core/plan-entitlements.constants";

export interface HuddleCapacityDeps {
  db: Db;
  planLimits: PlanLimitsService;
  orgSettings: ChatOrgSettingsService;
}

export async function assertHuddleJoinCapacity(
  deps: HuddleCapacityDeps,
  orgId: string,
  huddleId: number,
  callerMembershipId: number,
): Promise<void> {
  const activeParticipants = await deps.db.query.chatHuddleParticipants.findMany({
    where: and(
      eq(chatHuddleParticipants.orgId, orgId),
      eq(chatHuddleParticipants.huddleId, huddleId),
      isNull(chatHuddleParticipants.leftAt),
    ),
    columns: { membershipId: true },
    limit: HUDDLE_MESH_MAX_PARTICIPANTS + 1,
  });
  if (activeParticipants.some((p) => p.membershipId === callerMembershipId)) return;

  const { tier } = await deps.planLimits.resolveTier(orgId);
  if (!PLAN_FEATURE_FLAGS[tier].chatGroupHuddles && activeParticipants.length >= FREE_HUDDLE_MAX_PARTICIPANTS)
    throw new ForbiddenException(FREE_HUDDLE_UPGRADE_MESSAGE);

  const { maxHuddleParticipants } = await deps.orgSettings.getSettings(orgId);
  const effectiveCap = Math.min(maxHuddleParticipants, HUDDLE_MESH_MAX_PARTICIPANTS);
  if (activeParticipants.length >= effectiveCap)
    throw new ForbiddenException(`This call is full (max ${effectiveCap} participants)`);
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
