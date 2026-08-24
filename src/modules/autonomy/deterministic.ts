/**
 * The work that must never reach a model.
 *
 * Four things arrive with every inbound communication that a language model
 * would answer plausibly, slowly, at a cost, and sometimes wrongly — while a
 * dozen lines of code answer them exactly, for nothing, every time. Sending them
 * to a model is not just waste: a hallucinated thread match attaches a
 * customer's mail to the wrong account, and no confidence score makes that
 * acceptable.
 *
 * So this file is the boundary. Everything here is pure, total, and decided
 * before any model is considered.
 */

export interface AddressedMessage {
  readonly subject?: string | null;
  readonly body?: string | null;
  readonly fromAddress: string;
  readonly headers?: Readonly<Record<string, string>>;
}

// ── Thread matching ─────────────────────────────────────────────────────────

const REPLY_PREFIX = /^\s*(re|fwd|fw|aw|sv|vs|antw)\s*(\[\d+\])?\s*:\s*/i;

/**
 * Strips every reply and forward prefix, not just the outermost.
 *
 * A thread that has crossed three clients reads `Re: Fwd: RE: Quote` and the
 * naive single-strip leaves three different subjects, which is a conversation
 * scattered across three threads on the timeline.
 */
export function normaliseSubject(subject: string | null | undefined): string {
  let current = (subject ?? "").trim();
  let previous = "";

  while (current !== previous) {
    previous = current;
    current = current.replace(REPLY_PREFIX, "").trim();
  }

  return current.replace(/\s+/g, " ").toLowerCase();
}

/**
 * Matches a message to a thread using the provider's own headers first.
 *
 * `In-Reply-To` and `References` are the answer when they exist and are exact;
 * subject similarity is the fallback, and it is deliberately strict equality of
 * the normalised subject rather than fuzzy matching. A near-match here merges
 * two customers' conversations.
 */
export function matchThread(
  message: AddressedMessage,
  known: ReadonlyArray<{ threadId: string; messageIds: readonly string[]; subject: string | null }>,
): string | null {
  const headers = message.headers ?? {};
  const inReplyTo = (headers["in-reply-to"] ?? headers["In-Reply-To"] ?? "").trim();
  const references = (headers["references"] ?? headers["References"] ?? "")
    .split(/\s+/)
    .map((reference) => reference.trim())
    .filter(Boolean);

  const candidates = [inReplyTo, ...references].filter(Boolean);

  for (const candidate of candidates)
    for (const thread of known)
      if (thread.messageIds.includes(candidate)) return thread.threadId;

  const subject = normaliseSubject(message.subject);
  if (!subject) return null;

  const bySubject = known.filter((thread) => normaliseSubject(thread.subject) === subject);
  // Ambiguous is not a match. Two open threads with the same subject is a real
  // situation, and picking one at random is worse than attaching to neither.
  return bySubject.length === 1 ? (bySubject[0]?.threadId ?? null) : null;
}

// ── Domain to party ─────────────────────────────────────────────────────────

/**
 * Domains that identify a person, never an organisation.
 *
 * Matching `gmail.com` to a party would put every consumer sender on one record.
 * The list is short and deliberately not exhaustive — an unknown domain falls
 * through to "no organisation match", which is the safe answer.
 */
const CONSUMER_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "yandex.com",
  "qq.com",
  "163.com",
]);

export function isConsumerDomain(domain: string): boolean {
  return CONSUMER_DOMAINS.has(domain.trim().toLowerCase());
}

/**
 * Resolves a sender's domain to a party, or to nothing.
 *
 * Returns `null` rather than a best guess for a consumer domain or an ambiguous
 * match, because the caller's fallback — resolve by exact address — is correct
 * and cheap, while a wrong organisation match silently files a stranger's mail
 * onto a real customer's record.
 */
export function resolvePartyByDomain(
  domain: string,
  parties: ReadonlyArray<{ partyId: string; domain: string | null }>,
): string | null {
  const normalised = domain.trim().toLowerCase();
  if (!normalised || isConsumerDomain(normalised)) return null;

  const matches = parties.filter(
    (party) => (party.domain ?? "").trim().toLowerCase() === normalised,
  );

  return matches.length === 1 ? (matches[0]?.partyId ?? null) : null;
}

// ── Bounce and auto-reply detection ─────────────────────────────────────────

export type DeliveryClass = "delivered" | "bounce" | "auto-reply";

const BOUNCE_SENDERS = [
  "mailer-daemon@",
  "postmaster@",
  "no-reply@",
  "noreply@",
];

const BOUNCE_SUBJECTS = [
  "undeliverable",
  "delivery status notification",
  "returned mail",
  "mail delivery failed",
  "delivery has failed",
  "message not delivered",
];

const AUTO_REPLY_SUBJECTS = ["out of office", "automatic reply", "autoreply", "away from"];

/**
 * Classifies a message before anything downstream treats it as a reply.
 *
 * A bounce read as engagement advances a deal on the strength of a mail server
 * telling us the customer never received anything. An out-of-office read as a
 * reply does the same with a robot's words. Both are decided on headers and
 * fixed phrases — there is nothing here a model would do better.
 */
export function classifyDelivery(message: AddressedMessage): DeliveryClass {
  const headers = message.headers ?? {};
  const lower = (value: string | undefined | null): string => (value ?? "").trim().toLowerCase();

  const autoSubmitted = lower(headers["auto-submitted"] ?? headers["Auto-Submitted"]);
  if (autoSubmitted && autoSubmitted !== "no") return "auto-reply";

  if (lower(headers["x-autoreply"] ?? headers["X-Autoreply"])) return "auto-reply";
  if (lower(headers["x-failed-recipients"] ?? headers["X-Failed-Recipients"])) return "bounce";

  const from = lower(message.fromAddress);
  const subject = lower(message.subject);

  if (BOUNCE_SENDERS.some((sender) => from.startsWith(sender))) return "bounce";
  if (BOUNCE_SUBJECTS.some((phrase) => subject.includes(phrase))) return "bounce";
  if (AUTO_REPLY_SUBJECTS.some((phrase) => subject.includes(phrase))) return "auto-reply";

  return "delivered";
}

/** Only a real reply is evidence of anything. */
export function isEngagement(message: AddressedMessage): boolean {
  return classifyDelivery(message) === "delivered";
}

// ── Calendar parsing ────────────────────────────────────────────────────────

export interface ParsedInvite {
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly attendees: readonly string[];
  readonly title: string | null;
}

/**
 * Reads the fields a calendar event already states.
 *
 * The start time, the end time and the attendee list are structured data on the
 * invite. Asking a model to read them back is paying for a chance to get a
 * meeting time wrong.
 */
export function parseInvite(raw: {
  start?: string | null;
  end?: string | null;
  attendees?: readonly string[] | null;
  title?: string | null;
}): ParsedInvite | null {
  const startsAt = raw.start ? new Date(raw.start) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime())) return null;

  const parsedEnd = raw.end ? new Date(raw.end) : null;
  const endsAt = parsedEnd && !Number.isNaN(parsedEnd.getTime()) ? parsedEnd : null;

  return {
    startsAt,
    // An end before its start is bad data, not a zero-length meeting.
    endsAt: endsAt && endsAt.getTime() > startsAt.getTime() ? endsAt : null,
    attendees: (raw.attendees ?? [])
      .map((attendee) => attendee.trim().toLowerCase())
      .filter(Boolean),
    title: raw.title?.trim() || null,
  };
}
