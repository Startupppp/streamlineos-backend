import { timerSessions } from "../../../../db/schema";

/**
 * What a timer looks like to a client, and how its elapsed time is derived.
 *
 * Kept beside each other because the second is only correct with the first: a
 * RUNNING session's accumulated seconds are stale by construction — the clock
 * has moved since `lastResumedAt` — so the shape has to add the interval rather
 * than read the column, and any caller assembling this by hand would get a
 * running timer wrong and a paused one right.
 */

/** The row shape both helpers take: a session, optionally with its joins. */
export type TimerRow = typeof timerSessions.$inferSelect & {
  projectName?: string | null;
  ticketTitle?: string | null;
};

export function elapsedSeconds(session: {
  accumulatedSeconds: number;
  status: string;
  lastResumedAt: Date | null;
}): number {
  if (session.status !== "RUNNING" || !session.lastResumedAt) {
    return session.accumulatedSeconds;
  }
  const sinceResume = Math.floor((Date.now() - session.lastResumedAt.getTime()) / 1000);
  return session.accumulatedSeconds + sinceResume;
}

export function buildTimerShape(
  session: typeof timerSessions.$inferSelect & {
    projectName?: string | null;
    ticketTitle?: string | null;
  },
) {
  return {
    id: session.id,
    userMembershipId: session.userMembershipId,
    projectId: session.projectId,
    ticketId: session.ticketId,
    description: session.description,
    billable: session.billable,
    startedAt: session.startedAt,
    lastResumedAt: session.lastResumedAt,
    accumulatedSeconds: session.accumulatedSeconds,
    status: session.status,
    elapsedSeconds: elapsedSeconds(session),
    project:
      session.projectId && session.projectName
        ? { id: session.projectId, name: session.projectName }
        : null,
    ticket:
      session.ticketId && session.ticketTitle
        ? { id: session.ticketId, title: session.ticketTitle }
        : null,
  };
}
