import type { RelationshipSnapshot } from "../../src/modules/autonomy/outbound-eligibility";

/**
 * CRM-P2-11. The cases the three unattended deciders must keep getting right.
 *
 * Not a model dataset. The outbound judge, the risk score and the repair policy
 * are deterministic functions, so this is a regression corpus rather than an
 * accuracy sample — and that is the point: these three decide, without asking
 * anybody, whether to write to a customer, whether their contract is in
 * trouble, and whether to rewrite a field on their record. A prompt change
 * cannot break them. A refactor can, and nothing outside their own unit tests
 * would notice.
 *
 * Each case names the mistake it prevents rather than restating the branch,
 * because the gates below are asymmetric and the asymmetry has to be readable:
 * writing to somebody who opted out or who replied this morning is
 * unrecoverable, and missing one nudge costs a follow-up nobody sent.
 */

const NOW = new Date("2026-09-09T10:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

function snapshot(over: Partial<RelationshipSnapshot> = {}): RelationshipSnapshot {
  return {
    now: NOW,
    lastInboundAt: daysAgo(40),
    lastOutboundAt: daysAgo(30),
    lastAutonomousOutboundAt: null,
    dealState: "open",
    awaitingUs: false,
    nextStepDueAt: null,
    hasReachableAddress: true,
    ...over,
  };
}

export interface OutboundEvalCase {
  readonly snapshot: RelationshipSnapshot;
  /** What the loop must do. `false` means it must not write at all. */
  readonly shouldAct: boolean;
  /** Present only when acting; the class the judge has to pick. */
  readonly outboundClass?: string;
  /**
   * Whether writing here would be unrecoverable — a message to somebody who
   * answered, asked us to stop, or is owed a reply. These carry the zero-
   * tolerance gate; the rest carry recall.
   */
  readonly harmIfWritten: boolean;
}

export const OUTBOUND_DECISION_DATASET: readonly {
  name: string;
  input: OutboundEvalCase;
}[] = [
  {
    name: "silent open deal is nudged",
    input: {
      snapshot: snapshot({ lastOutboundAt: daysAgo(21) }),
      shouldAct: true,
      outboundClass: "nudge",
      harmIfWritten: false,
    },
  },
  {
    name: "they replied this morning",
    input: {
      snapshot: snapshot({ lastInboundAt: daysAgo(0.2), lastOutboundAt: daysAgo(30) }),
      shouldAct: false,
      harmIfWritten: true,
    },
  },
  {
    name: "they replied one minute after our last message",
    input: {
      snapshot: snapshot({
        lastOutboundAt: daysAgo(20),
        lastInboundAt: new Date(daysAgo(20).getTime() + 60_000),
      }),
      shouldAct: false,
      harmIfWritten: true,
    },
  },
  {
    name: "the outstanding next step is ours",
    input: {
      snapshot: snapshot({ awaitingUs: true }),
      shouldAct: false,
      harmIfWritten: true,
    },
  },
  {
    name: "no address on file",
    input: {
      snapshot: snapshot({ hasReachableAddress: false }),
      shouldAct: false,
      harmIfWritten: true,
    },
  },
  {
    name: "the deal is won",
    input: {
      snapshot: snapshot({ dealState: "won" }),
      shouldAct: false,
      harmIfWritten: true,
    },
  },
  {
    name: "the deal is lost",
    input: {
      snapshot: snapshot({ dealState: "lost" }),
      shouldAct: false,
      harmIfWritten: true,
    },
  },
  {
    name: "the system wrote to them two days ago",
    input: {
      snapshot: snapshot({
        lastOutboundAt: daysAgo(40),
        lastAutonomousOutboundAt: daysAgo(2),
      }),
      shouldAct: false,
      harmIfWritten: true,
    },
  },
  {
    name: "an overdue next step is chased",
    input: {
      snapshot: snapshot({
        lastOutboundAt: daysAgo(3),
        nextStepDueAt: daysAgo(4),
      }),
      shouldAct: true,
      outboundClass: "follow_up",
      harmIfWritten: false,
    },
  },
  {
    name: "a next step due this morning is not yet late",
    input: {
      snapshot: snapshot({ lastOutboundAt: daysAgo(3), nextStepDueAt: daysAgo(0.2) }),
      shouldAct: false,
      harmIfWritten: false,
    },
  },
  {
    name: "a long-silent relationship with nothing open gets a check-in",
    input: {
      /**
       * `lastInboundAt` older than `lastOutboundAt`, and it has to be: the
       * refusals are all checked first, so a reply newer than our last message
       * resolves to "they replied" whatever the silence says. The first draft of
       * this case inherited the base snapshot's 40-day inbound and scored a
       * refusal — the eval caught the fixture, which is what a fixture that is
       * wrong about the product looks like.
       */
      snapshot: snapshot({
        dealState: "none",
        lastInboundAt: daysAgo(90),
        lastOutboundAt: daysAgo(60),
      }),
      shouldAct: true,
      outboundClass: "check_in",
      harmIfWritten: false,
    },
  },
  {
    name: "a relationship with nothing open and three weeks of quiet is left alone",
    input: {
      snapshot: snapshot({ dealState: "none", lastOutboundAt: daysAgo(21) }),
      shouldAct: false,
      harmIfWritten: false,
    },
  },
  {
    name: "never contacted reads as maximally quiet, not as fresh",
    input: {
      snapshot: snapshot({ lastOutboundAt: null, lastInboundAt: null }),
      shouldAct: true,
      outboundClass: "nudge",
      harmIfWritten: false,
    },
  },
  {
    name: "a fast correspondent is chased sooner than the fixed threshold",
    input: {
      snapshot: snapshot({ lastOutboundAt: daysAgo(7), replyP50Seconds: 2 * 86_400 }),
      shouldAct: true,
      outboundClass: "nudge",
      harmIfWritten: false,
    },
  },
  {
    name: "a slow correspondent is not chased at the fixed threshold",
    input: {
      snapshot: snapshot({ lastOutboundAt: daysAgo(11), replyP50Seconds: 5 * 86_400 }),
      shouldAct: false,
      harmIfWritten: false,
    },
  },
];

export interface RiskEvalCase {
  readonly signals: readonly { impact: number; observedAt: Date }[];
  readonly renewalOn: string;
  readonly status: string;
  readonly asOf: Date;
  readonly expectedBand: "healthy" | "watch" | "at-risk";
  /**
   * Whether calling this customer healthy would be the dangerous error. A book
   * that reads a departing champion as fine is a renewal nobody prepared for.
   */
  readonly falseCalmIsHarm: boolean;
}

export const RISK_BAND_DATASET: readonly { name: string; input: RiskEvalCase }[] = [
  {
    name: "quiet contract far from renewal is healthy",
    input: {
      signals: [],
      renewalOn: "2027-06-30",
      status: "active",
      asOf: NOW,
      expectedBand: "healthy",
      falseCalmIsHarm: false,
    },
  },
  {
    /**
     * The measured answer, not the intuitive one, and worth stating.
     *
     * The impacts decay linearly to zero over 90 days, so at five and nine days
     * old a departed champion (35) and an escalation (25) are worth 33.1 and
     * 22.5 — 55.6 against an at-risk threshold of 60. It is `watch`, one band
     * below where a reader would put it. That is the model's decision and this
     * corpus records it rather than asserting what it wishes were true; the
     * case below crosses the line so both sides of the threshold are covered.
     */
    name: "a departed champion plus an escalation is on watch",
    input: {
      signals: [
        { impact: 35, observedAt: daysAgo(5) },
        { impact: 25, observedAt: daysAgo(9) },
      ],
      renewalOn: "2027-06-30",
      status: "active",
      asOf: NOW,
      expectedBand: "watch",
      falseCalmIsHarm: true,
    },
  },
  {
    name: "a champion departing today alongside falling usage is at risk",
    input: {
      signals: [
        { impact: 35, observedAt: NOW },
        { impact: 30, observedAt: daysAgo(1) },
      ],
      renewalOn: "2027-06-30",
      status: "active",
      asOf: NOW,
      expectedBand: "at-risk",
      falseCalmIsHarm: true,
    },
  },
  {
    name: "the same evidence a year later has decayed away",
    input: {
      signals: [
        { impact: 35, observedAt: daysAgo(300) },
        { impact: 25, observedAt: daysAgo(280) },
      ],
      renewalOn: "2027-06-30",
      status: "active",
      asOf: NOW,
      expectedBand: "healthy",
      falseCalmIsHarm: false,
    },
  },
  {
    name: "a renewal commitment pulls a worried account back",
    input: {
      signals: [
        { impact: 30, observedAt: daysAgo(10) },
        { impact: -40, observedAt: daysAgo(2) },
      ],
      renewalOn: "2027-06-30",
      status: "active",
      asOf: NOW,
      expectedBand: "healthy",
      falseCalmIsHarm: false,
    },
  },
  {
    name: "a renewal that has already gone by is not quiet",
    input: {
      signals: [{ impact: 20, observedAt: daysAgo(10) }],
      renewalOn: "2026-08-01",
      status: "active",
      asOf: NOW,
      expectedBand: "watch",
      falseCalmIsHarm: true,
    },
  },
];
