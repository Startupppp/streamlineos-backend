import {
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { timerSessions } from "../../../../db/schema";
import { actingMembershipId } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { buildTimerShape, type TimerRow } from "./timer-shape";

export interface TimerTransitionDeps {
  readonly db: Db;
  readonly reloadTimer: (orgId: string, timerId: number) => Promise<TimerRow | undefined>;
}

export async function pauseTimer(
  deps: TimerTransitionDeps,
  u: CurrentUserContext,
  timerId: number,
) {
  const membershipId = actingMembershipId(u.principal);
  const session = await deps.db.query.timerSessions.findFirst({
    where: and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)),
  });
  if (!session) throw new NotFoundException("Timer not found");
  if (session.userMembershipId !== membershipId) throw new ForbiddenException("Not your timer");
  if (session.status !== "RUNNING") throw new ConflictException("Timer is not running");

  const sinceResume = session.lastResumedAt
    ? Math.floor((Date.now() - session.lastResumedAt.getTime()) / 1000)
    : 0;
  const newAccumulated = session.accumulatedSeconds + sinceResume;

  await deps.db
    .update(timerSessions)
    .set({ status: "PAUSED", accumulatedSeconds: newAccumulated, updatedAt: new Date() })
    .where(and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)));

  const row = await deps.reloadTimer(u.orgId, timerId);
  if (!row) throw new InternalServerErrorException("Timer not found after update");
  return buildTimerShape(row);
}

export async function resumeTimer(
  deps: TimerTransitionDeps,
  u: CurrentUserContext,
  timerId: number,
) {
  const membershipId = actingMembershipId(u.principal);
  const session = await deps.db.query.timerSessions.findFirst({
    where: and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)),
  });
  if (!session) throw new NotFoundException("Timer not found");
  if (session.userMembershipId !== membershipId) throw new ForbiddenException("Not your timer");
  if (session.status !== "PAUSED") throw new ConflictException("Timer is not paused");

  await deps.db
    .update(timerSessions)
    .set({ status: "RUNNING", lastResumedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)));

  const row = await deps.reloadTimer(u.orgId, timerId);
  if (!row) throw new InternalServerErrorException("Timer not found after update");
  return buildTimerShape(row);
}

export async function stopTimer(
  deps: TimerTransitionDeps,
  u: CurrentUserContext,
  timerId: number,
) {
  const membershipId = actingMembershipId(u.principal);
  const session = await deps.db.query.timerSessions.findFirst({
    where: and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)),
  });
  if (!session) throw new NotFoundException("Timer not found");
  if (session.userMembershipId !== membershipId) throw new ForbiddenException("Not your timer");
  if (!["RUNNING", "PAUSED"].includes(session.status)) {
    throw new ConflictException("Timer is not active");
  }

  let newAccumulated = session.accumulatedSeconds;
  if (session.status === "RUNNING" && session.lastResumedAt) {
    newAccumulated += Math.floor((Date.now() - session.lastResumedAt.getTime()) / 1000);
  }

  await deps.db
    .update(timerSessions)
    .set({ status: "STOPPED", accumulatedSeconds: newAccumulated, updatedAt: new Date() })
    .where(and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)));

  const row = await deps.reloadTimer(u.orgId, timerId);
  if (!row) throw new InternalServerErrorException("Timer not found after update");
  return buildTimerShape(row);
}

export async function discardTimer(
  deps: TimerTransitionDeps,
  u: CurrentUserContext,
  timerId: number,
) {
  const membershipId = actingMembershipId(u.principal);
  const session = await deps.db.query.timerSessions.findFirst({
    where: and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)),
  });
  if (!session) throw new NotFoundException("Timer not found");
  if (session.userMembershipId !== membershipId) throw new ForbiddenException("Not your timer");

  await deps.db
    .update(timerSessions)
    .set({ status: "DISCARDED", updatedAt: new Date() })
    .where(and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)));

  return { success: true };
}
