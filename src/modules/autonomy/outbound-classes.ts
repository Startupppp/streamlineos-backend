import type { DecisionKind } from "../../db/schema/crm/autonomous-decisions";

/**
 * What kind of message the system decided to send, and which track it runs on.
 *
 * The class is not decoration. Ticket 08 stops a *class* for a party when a
 * human cancels one of them — "you may keep chasing this deal, stop asking them
 * for a meeting" is a real instruction and one nobody can express if every
 * outbound is the same thing. And the two tracks have different failure modes:
 * a bad follow-up annoys one customer, a bad cold campaign burns the sending
 * domain for every tenant sharing it, which is why they resolve to different
 * decision kinds and therefore different kill switches.
 */

export const OUTBOUND_CLASSES = [
  "follow_up",
  "nudge",
  "check_in",
  "meeting_request",
  "cold_outreach",
] as const;
export type OutboundClass = (typeof OUTBOUND_CLASSES)[number];

export const OUTBOUND_TRACKS = ["engaged", "cold"] as const;
export type OutboundTrack = (typeof OUTBOUND_TRACKS)[number];

/**
 * Cold is the only class on the cold track, and it is the only one that is.
 *
 * Written as a total map rather than `cls === "cold_outreach"` so adding a sixth
 * class is a compile error here rather than a silent enrolment onto whichever
 * track the expression happened to fall through to.
 */
const TRACK: Readonly<Record<OutboundClass, OutboundTrack>> = {
  follow_up: "engaged",
  nudge: "engaged",
  check_in: "engaged",
  meeting_request: "engaged",
  cold_outreach: "cold",
};

export function trackFor(outboundClass: OutboundClass): OutboundTrack {
  return TRACK[outboundClass];
}

/**
 * Which ledger kind — and therefore which kill switch — a class answers to.
 *
 * Cold outbound gets its own so an operator can stop every cold campaign on the
 * platform without also stopping the follow-ups, which are a different risk and
 * a different argument.
 */
export function decisionKindFor(outboundClass: OutboundClass): DecisionKind {
  return trackFor(outboundClass) === "cold" ? "cold_outbound.sent" : "outbound.sent";
}

/** What a person reads in the feed and on the countdown. */
export const OUTBOUND_CLASS_LABELS: Readonly<Record<OutboundClass, string>> = {
  follow_up: "Follow-up",
  nudge: "Nudge",
  check_in: "Check-in",
  meeting_request: "Meeting request",
  cold_outreach: "Cold outreach",
};

export function isOutboundClass(value: string): value is OutboundClass {
  return OUTBOUND_CLASSES.some((c) => c === value);
}
