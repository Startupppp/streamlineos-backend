import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { timerSessions } from "../../../../db/schema";
import { actingMembershipId } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { buildTimerShape, type TimerRow } from "./timer-shape";

/**
 * The four transitions of a running timer: pause, resume, stop, discard.
 *
 * Split from `timer.service.ts` because they are one state machine and nothing
 * else in that file is. Starting a timer has to decide what to do about an
 * already-running one, and converting a stopped timer writes a timesheet entry
 * through another service — these four only move a session between states, and
 * each is the same three steps: read the session, refuse if the actor is not
 * its owner or the state does not allow it, write the new state.
 *
 * `reloadTimer` is a callback rather than an imported read: it is the projected
 * read with project and ticket names joined, it stays on the service, and every
 * transition here ends by returning it.
 */
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
  return buildTimerShape(row!);
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
  return buildTimerShape(row!);
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
  return buildTimerShape(row!);
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
