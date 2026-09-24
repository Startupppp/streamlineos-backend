/**
 * How many people may be in a huddle, and who decides.
 *
 * Google Meet owns room capacity. StreamlineOS enforces only the commercial entitlement that
 * keeps Free-plan huddles one-to-one; paid rooms are admitted by Google Meet itself. Someone
 * already in a Free call is never refused re-entry: a dropped connection reconnecting must not
 * be told the room it is in is full.
 */
import { ForbiddenException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { chatHuddleParticipants } from "../../db/schema";
import type { Db } from "../../db/drizzle.types";
import type { PlanLimitsService } from "../billing/core/plan-limits.service";
import {
  FREE_HUDDLE_MAX_PARTICIPANTS,
  FREE_HUDDLE_UPGRADE_MESSAGE,
  PLAN_FEATURE_FLAGS,
} from "../billing/core/plan-entitlements.constants";

export interface HuddleCapacityDeps {
  db: Db;
  planLimits: PlanLimitsService;
}

export async function assertHuddleJoinCapacity(
  deps: HuddleCapacityDeps,
  orgId: string,
  huddleId: number,
  callerMembershipId: number,
): Promise<void> {
  const { tier } = await deps.planLimits.resolveTier(orgId);
  const freeCapped = !PLAN_FEATURE_FLAGS[tier].chatGroupHuddles;
  if (!freeCapped) return;

  const activeParticipants = await deps.db.query.chatHuddleParticipants.findMany({
    where: and(
      eq(chatHuddleParticipants.orgId, orgId),
      eq(chatHuddleParticipants.huddleId, huddleId),
      isNull(chatHuddleParticipants.leftAt),
    ),
    columns: { membershipId: true },
    limit: FREE_HUDDLE_MAX_PARTICIPANTS + 1,
  });
  if (activeParticipants.some((p) => p.membershipId === callerMembershipId)) return;

  if (activeParticipants.length >= FREE_HUDDLE_MAX_PARTICIPANTS)
    throw new ForbiddenException(FREE_HUDDLE_UPGRADE_MESSAGE);
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
    where: and(
      eq(chatHuddleParticipants.orgId, orgId),
      eq(chatHuddleParticipants.huddleId, huddleId),
      isNull(chatHuddleParticipants.leftAt),
    ),
    columns: { id: true },
    limit: FREE_HUDDLE_MAX_PARTICIPANTS + 1,
  });
  if (activeParticipants.length >= FREE_HUDDLE_MAX_PARTICIPANTS)
    throw new ForbiddenException(FREE_HUDDLE_UPGRADE_MESSAGE);
}
