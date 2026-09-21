import { timerSessions } from "../../../../db/schema";

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
