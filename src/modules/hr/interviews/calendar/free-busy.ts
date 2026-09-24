/**
 * Turning "when is each of these people busy" into "when can all of them meet".
 *
 * Pure interval arithmetic, kept away from the database and the providers so
 * the off-by-one cases — a slot that ends exactly when a meeting starts, a busy
 * block that swallows the whole window, a panel with one member who has no
 * calendar at all — are settled by a test rather than discovered in a booking.
 */

export interface Interval {
  start: Date;
  end: Date;
}

/** One person's busy time, and whether we actually know it. */
export interface PanelMemberBusy {
  /** Membership id, so this can be reported per person. */
  membershipId: number;
  busy: Interval[];
  /**
   * False when nothing could be read for this person — no connected calendar,
   * a provider that refused, a member with no membership row.
   *
   * This is not the same as "they are free", and conflating the two is how an
   * interviewer ends up double-booked by a system that was confident. A caller
   * that has to schedule anyway can proceed, but it has to say which people it
   * could not see.
   */
  known: boolean;
}

function byStart(a: Interval, b: Interval): number {
  return a.start.getTime() - b.start.getTime();
}

/**
 * Merges overlapping and touching intervals into the fewest that cover the same
 * time.
 *
 * Touching counts: 10:00-11:00 and 11:00-12:00 are one busy block from 10 to
 * 12, and leaving them separate would offer a zero-length gap at 11:00 as free.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((interval) => interval.end.getTime() > interval.start.getTime())
    .sort(byStart);

  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start.getTime() <= last.end.getTime()) {
      if (interval.end.getTime() > last.end.getTime()) last.end = interval.end;
      continue;
    }
    merged.push({ start: new Date(interval.start), end: new Date(interval.end) });
  }
  return merged;
}

/** The gaps inside `window` that `busy` does not cover. */
export function freeWithin(window: Interval, busy: readonly Interval[]): Interval[] {
  if (window.end.getTime() <= window.start.getTime()) return [];

  const free: Interval[] = [];
  let cursor = window.start;

  for (const block of mergeIntervals(busy)) {
    if (block.end.getTime() <= cursor.getTime()) continue;
    if (block.start.getTime() >= window.end.getTime()) break;
    if (block.start.getTime() > cursor.getTime()) {
      free.push({ start: cursor, end: new Date(Math.min(block.start.getTime(), window.end.getTime())) });
    }
    if (block.end.getTime() > cursor.getTime()) cursor = block.end;
    if (cursor.getTime() >= window.end.getTime()) break;
  }

  if (cursor.getTime() < window.end.getTime()) free.push({ start: cursor, end: window.end });
  return free;
}

/**
 * The time every panel member is free.
 *
 * Implemented as the free time left after treating the union of everybody's
 * busy blocks as one calendar, which is the same answer as intersecting each
 * person's free time and is one pass instead of N.
 */
export function panelFreeWithin(
  window: Interval,
  panel: readonly PanelMemberBusy[],
): Interval[] {
  const allBusy = panel.flatMap((member) => member.busy);
  return freeWithin(window, allBusy);
}

export interface SlotOptions {
  durationMinutes: number;
  /**
   * How far apart slot starts are placed. 30 by default so a 45-minute
   * interview is offered at :00 and :30 rather than at 9:00, 9:45, 10:30 —
   * times a candidate reads as arbitrary.
   */
  granularityMinutes?: number;
  /** Never offer a slot starting before this. */
  notBefore?: Date;
  /** At most this many, oldest first. */
  limit?: number;
}

/**
 * Cuts free windows into bookable slots.
 *
 * Starts are aligned to the granularity in UTC rather than to the window's own
 * start. A free window beginning at 09:07 — because a meeting ran to 09:07 —
 * would otherwise produce slots at 09:07, 09:37, 10:07, which nobody would
 * choose from.
 */
export function slotsFrom(free: readonly Interval[], options: SlotOptions): Interval[] {
  const durationMs = options.durationMinutes * 60_000;
  if (durationMs <= 0) return [];
  const granularityMs = (options.granularityMinutes ?? 30) * 60_000;
  const limit = options.limit ?? 50;
  const floor = options.notBefore?.getTime() ?? Number.NEGATIVE_INFINITY;

  const slots: Interval[] = [];
  for (const window of free) {
    const earliest = Math.max(window.start.getTime(), floor);
    let cursor = Math.ceil(earliest / granularityMs) * granularityMs;

    while (cursor + durationMs <= window.end.getTime()) {
      slots.push({ start: new Date(cursor), end: new Date(cursor + durationMs) });
      if (slots.length >= limit) return slots;
      cursor += granularityMs;
    }
  }
  return slots;
}

/** Whether a proposed interval runs over any of `busy`. */
export function overlapsAny(candidate: Interval, busy: readonly Interval[]): boolean {
  return busy.some(
    (block) =>
      candidate.start.getTime() < block.end.getTime() &&
      block.start.getTime() < candidate.end.getTime(),
  );
}
