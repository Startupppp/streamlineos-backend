import { capText } from "./decision-record";

/**
 * The neighbours a message is read with, and the three bounds that stop a thread
 * becoming an unbounded prompt.
 *
 * Ticket 12's evals found a defect no prompt reaches: on a messaging channel a
 * thought is not a message. Five fragments arrive in twenty seconds, they are
 * one decision, and not one of them carries it — because `processActivity` takes
 * a single activity id and never sees the other four. The fix is to judge a
 * message with the messages around it.
 *
 * Which immediately raises the bill, so the window is bounded three ways and
 * each bound answers a different question:
 *
 *   COUNT — how many messages are one thought? The burst the dataset records is
 *   five; ten covers a longer one. Past ten what is arriving is a back-and-forth
 *   rather than a thought, and every extra message is one more untrusted segment
 *   inside the same prompt fence.
 *
 *   TIME — when does a conversation stop being this conversation? WhatsApp
 *   threads on the pair of phone numbers and does so forever, so without a time
 *   bound "the thread" is every message ever exchanged with that customer. Half
 *   an hour is one exchange. A reply the next morning is a new conversation, and
 *   reading yesterday's already-answered request as live context is how a
 *   finished task gets created a second time.
 *
 *   CHARACTERS — what may one extraction send? The same four thousand a single
 *   message could already send. This is the bound that matters most and it is
 *   deliberately not a new budget: the ceiling on what an extraction costs does
 *   not move, the window only changes what fills it. It also makes "email is
 *   unaffected" structural rather than a channel flag somebody has to remember —
 *   a four-thousand-character email fills the budget by itself and gets a window
 *   of exactly one message, with a prompt byte-for-byte identical to today's.
 *
 * Pure, so all three are provable without a database.
 */

/** The whole window's share of a prompt — the cap one message already had. */
export const THREAD_WINDOW_CHARS = 4_000;

/** Messages, including the one being judged. See COUNT above. */
export const THREAD_WINDOW_MAX_MESSAGES = 10;

/** How far back a neighbour may be and still be this conversation. */
export const THREAD_WINDOW_MINUTES = 30;

/** How the conversation is assembled — the same join subject and body use. */
const SEPARATOR = "\n\n";

/**
 * One row of a thread, as much of it as this decision needs.
 *
 * Deliberately not the whole activity: this file decides what a model reads, and
 * a field it cannot see is a field it cannot leak.
 */
export interface ThreadActivity {
  readonly activityId: string;
  readonly kind: string;
  readonly subject: string | null;
  readonly body: string | null;
  readonly occurredAt: Date;
  /** `human` or `system`. The seam files inbound messages as `system`. */
  readonly actorKind: string;
  /** `manual`, an adapter name, or `extraction` for what this module wrote. */
  readonly source: string;
}

export interface ThreadWindow {
  /** Oldest first, so a later message reads as answering an earlier one. */
  readonly messages: readonly ThreadActivity[];
  /** What goes inside the prompt fence. */
  readonly conversation: string;
  /**
   * Next steps this thread already produced inside this window.
   *
   * Read from the same rows, because the alternative is a second query asking
   * the same question. See `alreadyHandled`.
   */
  readonly alreadyDone: readonly string[];
  /** Neighbours the bounds refused, so the cost of the window is visible. */
  readonly dropped: number;
}

/** Where the window starts, given the message being judged. */
export function windowStart(triggerOccurredAt: Date): Date {
  return new Date(triggerOccurredAt.getTime() - THREAD_WINDOW_MINUTES * 60_000);
}

/** A message as the model reads it. Identical to what one activity produced. */
function textOf(row: ThreadActivity): string {
  return [row.subject, row.body].filter(Boolean).join(SEPARATOR);
}

/**
 * A total order over a thread, because timestamps collide.
 *
 * The same order the timeline indexes are built on, and for the same reason its
 * comment gives: an import of a mail folder writes hundreds of rows in the same
 * second, and "before the trigger" has to mean something in that case too.
 */
function compare(left: ThreadActivity, right: ThreadActivity): number {
  const difference = left.occurredAt.getTime() - right.occurredAt.getTime();
  if (difference !== 0) return difference;
  return left.activityId < right.activityId ? -1 : left.activityId > right.activityId ? 1 : 0;
}

function isBefore(row: ThreadActivity, trigger: ThreadActivity): boolean {
  return compare(row, trigger) < 0;
}

/**
 * Whether a row is something the other side said.
 *
 * Today every threaded activity is inbound — the ingress seam is the only writer
 * of `thread_id` — so this filter changes nothing yet. It is here because the
 * day somebody logs our own reply onto the thread, an unattributed window would
 * hand the model our sentence as if the customer had written it, and "who owes
 * the next step" is decided by exactly that. A rule that has to be added later,
 * after the wrong tasks have been created, is a rule that arrives too late.
 */
function isInboundMessage(row: ThreadActivity): boolean {
  return row.kind !== "task" && row.actorKind === "system" && row.source !== "extraction";
}

/** A next step this module already created from this thread. */
function isOwnTask(row: ThreadActivity): boolean {
  return row.kind === "task" && row.source === "extraction";
}

/**
 * The window around one message.
 *
 * `thread` is what the read returned — the last few things on this thread,
 * newest first, the trigger possibly among them. Order is not trusted: this
 * decides it, because the whole point of the window is that a later message
 * reads as answering an earlier one.
 */
export function buildThreadWindow(
  trigger: ThreadActivity,
  thread: readonly ThreadActivity[],
): ThreadWindow {
  const start = windowStart(trigger.occurredAt);

  const inWindow = thread.filter(
    (row) =>
      row.activityId !== trigger.activityId &&
      row.occurredAt.getTime() >= start.getTime() &&
      isBefore(row, trigger),
  );

  const neighbours = inWindow
    .filter(isInboundMessage)
    .sort((left, right) => compare(right, left));

  /**
   * The message being judged takes the budget first, capped exactly as it was
   * before this file existed. A message that fills the budget on its own gets no
   * neighbours, which is the correct answer rather than a limitation.
   */
  const chosen: ThreadActivity[] = [trigger];
  let used = capText(textOf(trigger), THREAD_WINDOW_CHARS).length;
  let dropped = 0;

  for (const neighbour of neighbours) {
    const cost = SEPARATOR.length + textOf(neighbour).length;

    /**
     * Stops at the first neighbour that does not fit rather than skipping it.
     *
     * Skipping would keep going and hand the model a conversation with a hole in
     * the middle, which reads as a different conversation from the one that
     * happened. A window with a gap is worse than a shorter one.
     */
    if (chosen.length >= THREAD_WINDOW_MAX_MESSAGES || used + cost > THREAD_WINDOW_CHARS) {
      dropped = neighbours.length - (chosen.length - 1);
      break;
    }

    chosen.push(neighbour);
    used += cost;
  }

  const messages = [...chosen].sort(compare);

  return {
    messages,
    // Capped again at the end: the fill above is bounded by construction, and
    // this is the line that stays true if somebody changes the fill.
    conversation: capText(messages.map(textOf).join(SEPARATOR), THREAD_WINDOW_CHARS),
    alreadyDone: inWindow
      .filter(isOwnTask)
      .map((row) => row.subject ?? "")
      .filter((description) => description.length > 0),
    dropped,
  };
}

/** The messages a window holds, for the eligibility judgement to fold over. */
export function windowMessages(window: ThreadWindow): string[] {
  return window.messages.map(textOf);
}

/**
 * Whether this thread has already been told to do this.
 *
 * A window makes the same request reachable from every message that follows it:
 * "can you send the quote" and then "thanks" produce two extractions, and the
 * second one can see the first message. Without this, thread context would turn
 * one request into a task per message after it — a new defect introduced by a
 * fix.
 *
 * Compared on the normalised text rather than an id because there is nothing
 * else to compare: two extractions of the same request are two independent
 * readings of it, and the only thing that makes them the same next step is that
 * they say the same thing. Punctuation and case are the parts a model varies
 * between readings, so they are removed before the comparison.
 *
 * It sees only what the thread read returned, so on a thread busy enough to fill
 * the count bound with newer messages an older task can fall out of view and the
 * step be created twice. That is the bound working rather than failing: the
 * alternative is a second query with no limit on it, and an unbounded read is
 * the thing this whole file exists to refuse.
 */
export function alreadyHandled(window: ThreadWindow, description: string): boolean {
  const wanted = normaliseStep(description);
  if (!wanted) return false;
  return window.alreadyDone.some((done) => normaliseStep(done) === wanted);
}

function normaliseStep(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
