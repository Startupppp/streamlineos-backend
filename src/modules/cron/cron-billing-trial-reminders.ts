const REMINDER_DAYS = [7, 3, 1] as const;

interface TrialEnd {
  trialEndsAt: Date | null;
}

export function dueReminderDays(trialEnds: readonly TrialEnd[], now: Date): number[] {
  const due: number[] = [];

  for (const days of REMINDER_DAYS) {
    const windowStart = new Date(now);
    windowStart.setDate(windowStart.getDate() + days);
    windowStart.setHours(0, 0, 0, 0);
    const windowEnd = new Date(windowStart);
    windowEnd.setHours(23, 59, 59, 999);

    const soonExpiring = trialEnds.some(
      (row) =>
        row.trialEndsAt !== null &&
        row.trialEndsAt >= windowStart &&
        row.trialEndsAt <= windowEnd,
    );

    if (soonExpiring) due.push(days);
  }

  return due;
}
