import type { TimelineEntry } from "./activity-timeline";

/**
 * A person's own open tasks.
 *
 * The same rows the timeline shows, but not the same read. A timeline answers
 * "what happened to this customer", newest first; a task list answers "what do I
 * owe, and when", soonest first. Ordering a task list by when each row was
 * written puts the one created this morning above the one that was due last
 * week, which is the opposite of what the screen is for — and it ignores
 * `idx_activities_assignee_open`, which the schema declares on `due_at` for
 * exactly this read.
 *
 * Pure, for the same reason the timeline half is: ordering and cursor decisions
 * have to hold identically wherever they are applied and none of them needs a
 * database to be proved right.
 */

/** What a task is about. Exactly one anchor, held by a CHECK constraint. */
export interface TaskAnchorRef {
  readonly kind: "party" | "deal" | "subject";
  readonly id: string;
  readonly name: string | null;
}

/** A row as the query returns it: the timeline shape plus its anchor, unresolved. */
export interface TaskRow extends TimelineEntry {
  readonly partyId: string | null;
  readonly dealId: string | null;
  readonly subjectId: string | null;
  readonly partyName: string | null;
  readonly dealName: string | null;
  readonly subjectTitle: string | null;
}

/** A row as a reader gets it. */
export interface TaskEntry extends TimelineEntry {
  readonly anchor: TaskAnchorRef | null;
}

/**
 * A keyset position in due-date order.
 *
 * `dueAt` is nullable because a task without a date is still a task — it sorts
 * last rather than being hidden — so the cursor has to be able to say "no date"
 * rather than only carrying one. A timeline cursor cannot express that.
 */
export interface TaskPosition {
  readonly dueAt: string | null;
  readonly activityId: string;
}

const HAS_DUE_DATE = "0";
const NO_DUE_DATE = "1";

export function encodeTaskCursor(position: TaskPosition): string {
  const flag = position.dueAt === null ? NO_DUE_DATE : HAS_DUE_DATE;
  return Buffer.from(`${flag}|${position.dueAt ?? ""}|${position.activityId}`, "utf8").toString(
    "base64url",
  );
}

/**
 * Returns undefined rather than throwing on anything malformed.
 *
 * A cursor arrives in a URL, so it is attacker-controlled and gets mangled by
 * copy-paste. Falling back to the first page is what a reader expects; a 500 is
 * not. The identifier is taken as the whole remainder because an identifier may
 * contain the separator and the two fields before it never do.
 */
export function decodeTaskCursor(cursor: string | null | undefined): TaskPosition | undefined {
  if (!cursor) return undefined;

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return undefined;
  }

  const firstSeparator = decoded.indexOf("|");
  if (firstSeparator !== 1) return undefined;
  const secondSeparator = decoded.indexOf("|", firstSeparator + 1);
  if (secondSeparator < 0) return undefined;

  const flag = decoded.slice(0, firstSeparator);
  const dueAt = decoded.slice(firstSeparator + 1, secondSeparator);
  const activityId = decoded.slice(secondSeparator + 1);
  if (!activityId) return undefined;

  if (flag === NO_DUE_DATE) return dueAt === "" ? { dueAt: null, activityId } : undefined;
  if (flag !== HAS_DUE_DATE) return undefined;
  if (Number.isNaN(new Date(dueAt).getTime())) return undefined;

  return { dueAt, activityId };
}

/**
 * Which record the task belongs to, resolved to something a reader can act on.
 *
 * A name may be missing where the anchor has since been deleted; the row still
 * renders, because hiding a task because its customer went away loses the task.
 */
export function taskAnchor(row: TaskRow): TaskAnchorRef | null {
  if (row.partyId) return { kind: "party", id: row.partyId, name: row.partyName };
  if (row.dealId) return { kind: "deal", id: row.dealId, name: row.dealName };
  if (row.subjectId) return { kind: "subject", id: row.subjectId, name: row.subjectTitle };
  return null;
}

/** Postgres `serial`. A value above it is not a deal id, whatever it parses to. */
const MAX_SERIAL = 2_147_483_647;

/**
 * The deal ids on a page, as `deals.id` can actually be compared to.
 *
 * `activities.deal_id` is text and `deals.id` is a serial, so the two are joined
 * by coercion rather than by a foreign key. Doing that coercion in SQL means a
 * single activity anchored to a non-numeric string raises 22P02 and takes the
 * whole screen down with it — and `dealId` on the create schema is a free string,
 * so any caller who may log an activity can plant one. Coercing here instead,
 * where a value that is not a deal id is simply left out.
 */
export function numericDealIds(ids: readonly (string | null)[]): number[] {
  const parsed = new Set<number>();

  for (const id of ids) {
    if (!id || !/^[1-9][0-9]{0,9}$/.test(id)) continue;
    const value = Number(id);
    if (value <= MAX_SERIAL) parsed.add(value);
  }

  return [...parsed];
}

export interface TaskPage {
  readonly data: TaskEntry[];
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
 * count query — counting a task list of thousands is the query that makes the
 * screen slow.
 */
export function buildTaskPage(rows: readonly TaskRow[], limit: number): TaskPage {
  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept[kept.length - 1];

  const data = kept.map(
    (row): TaskEntry => ({
      activityId: row.activityId,
      kind: row.kind,
      occurredAt: row.occurredAt,
      subject: row.subject,
      body: row.body,
      threadId: row.threadId,
      actorKind: row.actorKind,
      actorLabel: row.actorLabel,
      actorName: row.actorName,
      dueAt: row.dueAt,
      completedAt: row.completedAt,
      source: row.source,
      anchor: taskAnchor(row),
    }),
  );

  return {
    data,
    pagination: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeTaskCursor({
              dueAt: last.dueAt ? last.dueAt.toISOString() : null,
              activityId: last.activityId,
            })
          : null,
    },
  };
}
