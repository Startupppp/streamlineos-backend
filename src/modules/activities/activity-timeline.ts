import type { ActivityActorKind, ActivityKind } from "../../db/schema/crm/activities";

/**
 * Reading a timeline.
 *
 * Pure, because everything here is a decision about presentation and ordering
 * that has to hold identically for a party, a deal and a subject, and none of it
 * needs a database to be proved right.
 */

/** What a timeline is anchored to. Exactly one, never a type-plus-id pair. */
export type TimelineAnchor =
  | { readonly kind: "party"; readonly partyId: string }
  | { readonly kind: "deal"; readonly dealId: number }
  | { readonly kind: "subject"; readonly subjectId: string };

export interface TimelineEntry {
  readonly activityId: string;
  readonly kind: ActivityKind;
  readonly occurredAt: Date;
  readonly subject: string | null;
  readonly body: string | null;
  readonly threadId: string | null;
  readonly actorKind: ActivityActorKind;
  readonly actorLabel: string | null;
  readonly actorName: string | null;
  readonly dueAt: Date | null;
  readonly completedAt: Date | null;
  readonly source: string;
}

/**
 * A keyset position.
 *
 * Two columns, because `occurred_at` alone is not a total order — importing a
 * mail folder writes hundreds of rows in the same second, and a cursor on a
 * non-unique column silently skips or repeats rows at every page boundary.
 */
export interface TimelinePosition {
  readonly occurredAt: string;
  readonly activityId: string;
}

export function encodeTimelineCursor(position: TimelinePosition): string {
  return Buffer.from(`${position.occurredAt}|${position.activityId}`, "utf8").toString("base64url");
}

/**
 * Returns undefined rather than throwing on a malformed cursor.
 *
 * A cursor arrives in a URL, so it is attacker-controlled and gets mangled by
 * copy-paste. Falling back to the first page is the behaviour a reader expects;
 * a 500 is not.
 */
export function decodeTimelineCursor(cursor: string | null | undefined): TimelinePosition | undefined {
  if (!cursor) return undefined;

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return undefined;
  }

  // Split on the FIRST separator, not the last: the timestamp is fixed-format
  // and never contains one, but an identifier may.
  const separator = decoded.indexOf("|");
  if (separator <= 0) return undefined;

  const occurredAt = decoded.slice(0, separator);
  const activityId = decoded.slice(separator + 1);
  if (!activityId || Number.isNaN(new Date(occurredAt).getTime())) return undefined;

  return { occurredAt, activityId };
}

export interface TimelinePage {
  readonly data: TimelineEntry[];
  readonly pagination: {
    readonly limit: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}

/**
 * Turns one over-fetched row set into a page.
 *
 * The caller asks for `limit + 1` so "is there more" is known without a second
 * count query — a count over a timeline of thousands is the query that makes the
 * screen slow.
 */
export function buildTimelinePage(rows: TimelineEntry[], limit: number): TimelinePage {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];

  return {
    data,
    pagination: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeTimelineCursor({
              occurredAt: last.occurredAt.toISOString(),
              activityId: last.activityId,
            })
          : null,
    },
  };
}

/**
 * A task is overdue when it has a due date in the past and is not done.
 *
 * Stated once because the timeline, the task list and the mobile card each need
 * it and three copies of a date comparison is three chances to disagree about
 * what "today" means.
 */
export function isOverdue(entry: Pick<TimelineEntry, "kind" | "dueAt" | "completedAt">, now: Date): boolean {
  if (entry.kind !== "task") return false;
  if (entry.completedAt) return false;
  return entry.dueAt !== null && entry.dueAt.getTime() < now.getTime();
}

/** Whether a reader should see this as the system's work rather than a person's. */
export function isAutonomous(entry: Pick<TimelineEntry, "actorKind">): boolean {
  return entry.actorKind === "system";
}

/**
 * What the entry says it is, in a reader's words.
 *
 * Never an identifier, and never a bare kind — "Email" alone tells a person
 * nothing they could not see from the icon.
 */
export function describeEntry(entry: TimelineEntry): string {
  if (entry.subject?.trim()) return entry.subject.trim();

  switch (entry.kind) {
    case "call":
      return "Call";
    case "email":
      return "Email";
    case "meeting":
      return "Meeting";
    case "note":
      return "Note";
    case "task":
      return "Task";
  }
}

/**
 * Groups entries under day headings, preserving order within each day.
 *
 * The timeline is a reading surface, and an undifferentiated list of four
 * hundred rows is not read — it is scrolled past.
 */
export function groupByDay(entries: readonly TimelineEntry[]): Array<{
  day: string;
  entries: TimelineEntry[];
}> {
  const days: Array<{ day: string; entries: TimelineEntry[] }> = [];

  for (const entry of entries) {
    const day = entry.occurredAt.toISOString().slice(0, 10);
    const current = days[days.length - 1];
    if (current && current.day === day) current.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }

  return days;
}
