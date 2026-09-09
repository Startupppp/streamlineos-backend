import {
  EARLIEST_SILENCE_DAYS,
  judgeOutbound,
  NUDGE_AFTER_DAYS,
  OUTBOUND_SPACING_DAYS,
  silenceThresholdDays,
  type RelationshipSnapshot,
} from "./outbound-eligibility";

const NOW = new Date("2026-08-26T10:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

function snapshot(overrides: Partial<RelationshipSnapshot> = {}): RelationshipSnapshot {
  return {
    now: NOW,
    lastInboundAt: daysAgo(30),
    lastOutboundAt: daysAgo(20),
    lastAutonomousOutboundAt: null,
    dealState: "open",
    awaitingUs: false,
    nextStepDueAt: null,
    hasReachableAddress: true,
    ...overrides,
  };
}

describe("judgeOutbound", () => {
  it("refuses when there is no address to reach them at", () => {
    const verdict = judgeOutbound(snapshot({ hasReachableAddress: false }));
    expect(verdict).toEqual({ act: false, reason: "no-reachable-address" });
  });

  it("refuses on a won deal — the chase is over", () => {
    expect(judgeOutbound(snapshot({ dealState: "won" }))).toEqual({
      act: false,
      reason: "deal-closed",
    });
  });

  it("refuses on a lost deal", () => {
    expect(judgeOutbound(snapshot({ dealState: "lost" }))).toEqual({
      act: false,
      reason: "deal-closed",
    });
  });

  /**
   * The adversarial case the brief names. A reply after our last message means
   * the silence this loop exists to break is not silence, and chasing it reads
   * to the customer as a system that does not read their mail.
   */
  it("refuses when they replied after our last message", () => {
    expect(
      judgeOutbound(
        snapshot({ lastOutboundAt: daysAgo(9), lastInboundAt: daysAgo(1) }),
      ),
    ).toEqual({ act: false, reason: "they-replied" });
  });

  it("still refuses when the reply landed one second after our message", () => {
    const ours = daysAgo(9);
    expect(
      judgeOutbound(
        snapshot({
          lastOutboundAt: ours,
          lastInboundAt: new Date(ours.getTime() + 1000),
        }),
      ),
    ).toEqual({ act: false, reason: "they-replied" });
  });

  it("does not treat a reply that arrived BEFORE our last message as a reply", () => {
    const verdict = judgeOutbound(
      snapshot({ lastOutboundAt: daysAgo(12), lastInboundAt: daysAgo(13) }),
    );
    expect(verdict).toEqual({
      act: true,
      outboundClass: "nudge",
      reason: "silence-on-an-open-deal",
    });
  });

  it("refuses when the next step is ours — nudging them for our own homework", () => {
    expect(
      judgeOutbound(snapshot({ awaitingUs: true, nextStepDueAt: daysAgo(3) })),
    ).toEqual({ act: false, reason: "the-ball-is-ours" });
  });

  it("never decides to ask for a meeting on its own", () => {
    /**
     * CRM-P1-08. This used to assert the opposite, by handing `judgeOutbound` a
     * snapshot with `meetingRequested: true` — a value the only real snapshot
     * builder hardcoded false and the compose API had no way to supply. The
     * test proved a branch nothing could reach, which is the shape of a green
     * gate over dead code.
     *
     * The branch is gone. `meeting_request` stays in the class vocabulary
     * because a human uses it to say "stop asking them for a meeting", and
     * because a wired version would return there — so this asserts the honest
     * state instead: no input to the judge produces it.
     */
    const decisions = [
      snapshot({ nextStepDueAt: daysAgo(2) }),
      snapshot({ lastInboundAt: daysAgo(30), lastOutboundAt: daysAgo(30) }),
      snapshot({ dealState: "open", lastOutboundAt: daysAgo(60) }),
    ].map((s) => judgeOutbound(s));

    for (const decision of decisions) {
      if (decision.act) expect(decision.outboundClass).not.toBe("meeting_request");
    }
  });

  it("follows up on a next step that came and went", () => {
    expect(
      judgeOutbound(snapshot({ awaitingUs: false, nextStepDueAt: daysAgo(2) })),
    ).toEqual({ act: true, outboundClass: "follow_up", reason: "next-step-overdue" });
  });

  it("does not follow up on a next step that is not due yet", () => {
    const verdict = judgeOutbound(
      snapshot({
        nextStepDueAt: new Date(NOW.getTime() + 86_400_000),
        lastOutboundAt: daysAgo(1),
        lastInboundAt: daysAgo(40),
      }),
    );
    expect(verdict).toEqual({ act: false, reason: "nothing-to-say" });
  });

  it("nudges an open deal that has gone quiet", () => {
    expect(
      judgeOutbound(
        snapshot({ dealState: "open", lastOutboundAt: daysAgo(12), lastInboundAt: daysAgo(30) }),
      ),
    ).toEqual({ act: true, outboundClass: "nudge", reason: "silence-on-an-open-deal" });
  });

  it("checks in on a relationship with no open deal", () => {
    expect(
      judgeOutbound(
        snapshot({ dealState: "none", lastOutboundAt: daysAgo(60), lastInboundAt: daysAgo(70) }),
      ),
    ).toEqual({ act: true, outboundClass: "check_in", reason: "long-silence" });
  });

  it("says nothing-to-say rather than inventing a reason", () => {
    expect(
      judgeOutbound(
        snapshot({ dealState: "none", lastOutboundAt: daysAgo(3), lastInboundAt: daysAgo(70) }),
      ),
    ).toEqual({ act: false, reason: "nothing-to-say" });
  });

  /**
   * Compose-time spacing, which is NOT the frequency cap. The cap is enforced at
   * send time by the guardrail and counts every loop; this only stops one loop
   * re-drafting the same nudge every hour.
   */
  it("refuses to draft again inside its own spacing window", () => {
    expect(
      judgeOutbound(
        snapshot({
          lastAutonomousOutboundAt: daysAgo(OUTBOUND_SPACING_DAYS - 1),
          lastOutboundAt: daysAgo(20),
        }),
      ),
    ).toEqual({ act: false, reason: "too-soon-since-our-last" });
  });

  it("allows drafting once the spacing window has passed", () => {
    const verdict = judgeOutbound(
      snapshot({
        lastAutonomousOutboundAt: daysAgo(OUTBOUND_SPACING_DAYS + 1),
        lastOutboundAt: daysAgo(20),
      }),
    );
    expect(verdict.act).toBe(true);
  });

  it("treats a relationship we have never contacted as quiet, not as fresh", () => {
    const verdict = judgeOutbound(
      snapshot({ lastOutboundAt: null, lastInboundAt: daysAgo(45), dealState: "open" }),
    );
    expect(verdict).toEqual({ act: true, outboundClass: "nudge", reason: "silence-on-an-open-deal" });
  });

  it("never proposes cold outreach — that track is not entered from a relationship", () => {
    const classes = new Set<string>();
    for (const dealState of ["open", "none", "won", "lost"] as const) {
      for (const days of [1, 6, 12, 40, 90]) {
        const verdict = judgeOutbound(
          snapshot({ dealState, lastOutboundAt: daysAgo(days), lastInboundAt: daysAgo(days + 5) }),
        );
        if (verdict.act) classes.add(verdict.outboundClass);
      }
    }
    expect(classes.has("cold_outreach")).toBe(false);
  });
});

/**
 * CRM-P2-10. Silence measured against how this customer actually answers.
 *
 * `reply_p50_seconds` has been computed and stored since relationships shipped
 * and was read by nothing, so every relationship was judged silent at the same
 * ten days — which is early for somebody whose normal turnaround is three weeks
 * and very late for somebody who answers within the hour.
 */
describe("silenceThresholdDays", () => {
  it("keeps the fixed threshold when no cadence has been observed", () => {
    /** The ordinary case: a relationship with one message in it has no median. */
    expect(silenceThresholdDays(NUDGE_AFTER_DAYS, null)).toBe(NUDGE_AFTER_DAYS);
    expect(silenceThresholdDays(NUDGE_AFTER_DAYS, undefined)).toBe(NUDGE_AFTER_DAYS);
  });

  it("treats a broken measurement as no measurement", () => {
    /**
     * Zero is not "replies instantly". Reading it that way would clamp every
     * relationship whose statistics have not been computed properly to the
     * floor, which is the most aggressive setting available.
     */
    expect(silenceThresholdDays(NUDGE_AFTER_DAYS, 0)).toBe(NUDGE_AFTER_DAYS);
    expect(silenceThresholdDays(NUDGE_AFTER_DAYS, -60)).toBe(NUDGE_AFTER_DAYS);
    expect(silenceThresholdDays(NUDGE_AFTER_DAYS, Number.NaN)).toBe(NUDGE_AFTER_DAYS);
  });

  it("shortens it for somebody who normally answers quickly", () => {
    /** A two-day turnaround: six days of nothing is three of their rhythms. */
    expect(silenceThresholdDays(NUDGE_AFTER_DAYS, 2 * 86_400)).toBe(6);
  });

  it("lengthens it for somebody whose normal turnaround is long", () => {
    /** A five-day turnaround puts the nudge at fifteen, not at ten. */
    expect(silenceThresholdDays(NUDGE_AFTER_DAYS, 5 * 86_400)).toBe(15);
  });

  it("will not chase somebody the same afternoon they were written to", () => {
    /**
     * A ten-minute median would otherwise put the threshold at half an hour.
     * The floor is three days for a nudge, which is inside OUTBOUND_SPACING_DAYS
     * and therefore cannot produce a second message even at the extreme.
     */
    const floor = silenceThresholdDays(NUDGE_AFTER_DAYS, 600);
    expect(floor).toBe(3);
    expect(floor).toBeLessThan(OUTBOUND_SPACING_DAYS);
  });

  it("will not let a slow correspondent push an open deal into a year of silence", () => {
    /** Three months between replies does not make a hundred-day gap acceptable. */
    expect(silenceThresholdDays(NUDGE_AFTER_DAYS, 90 * 86_400)).toBe(20);
  });

  it("scales the band with whichever threshold it is adjusting", () => {
    /**
     * The same rule serves the check-in threshold, so the band is a fraction
     * rather than a pair of absolute days — otherwise the floor written for a
     * nudge would silently become the rule for a 45-day check-in too.
     */
    expect(silenceThresholdDays(45, 600)).toBeCloseTo(13.5, 5);
    expect(silenceThresholdDays(45, 90 * 86_400)).toBe(90);
  });
});

describe("judgeOutbound reads the customer's own cadence", () => {
  it("nudges a fast correspondent before the fixed threshold would", () => {
    const verdict = judgeOutbound(
      snapshot({
        lastInboundAt: daysAgo(30),
        lastOutboundAt: daysAgo(7),
        replyP50Seconds: 2 * 86_400,
      }),
    );

    expect(verdict).toEqual({
      act: true,
      outboundClass: "nudge",
      reason: "silence-on-an-open-deal",
    });
  });

  it("holds off on a slow correspondent the fixed threshold would have chased", () => {
    /**
     * The half of this that protects the customer. At eleven days the old rule
     * nudged; somebody who takes five days to answer is not late at eleven, and
     * the message would arrive as nagging rather than as attention.
     */
    const verdict = judgeOutbound(
      snapshot({
        lastInboundAt: daysAgo(30),
        lastOutboundAt: daysAgo(11),
        replyP50Seconds: 5 * 86_400,
      }),
    );

    expect(verdict).toEqual({ act: false, reason: "nothing-to-say" });
  });

  it("changes nothing for a relationship with no measured cadence", () => {
    /** The regression guard: every existing relationship keeps the old answer. */
    const quiet = snapshot({ lastInboundAt: daysAgo(30), lastOutboundAt: daysAgo(11) });

    expect(judgeOutbound(quiet)).toEqual({
      act: true,
      outboundClass: "nudge",
      reason: "silence-on-an-open-deal",
    });
    expect(judgeOutbound({ ...quiet, lastOutboundAt: daysAgo(9) })).toEqual({
      act: false,
      reason: "nothing-to-say",
    });
  });

  it("still refuses a reply, however quiet the cadence says it is", () => {
    /**
     * Ordering, restated against the new input: the refusals are all checked
     * before any reason to act, so a cadence that says "overdue" cannot
     * outrank the fact that they answered.
     */
    expect(
      judgeOutbound(
        snapshot({
          lastOutboundAt: daysAgo(30),
          lastInboundAt: daysAgo(1),
          replyP50Seconds: 3_600,
        }),
      ),
    ).toEqual({ act: false, reason: "they-replied" });
  });

  it("is the earliest anything can be due, so the sweep cuts there", () => {
    /**
     * The number that keeps the sweep and the judge agreeing. If the sweep still
     * cut at NUDGE_AFTER_DAYS, no fast-replying relationship would ever be
     * handed over and the whole mechanism would be inert while looking finished.
     */
    expect(EARLIEST_SILENCE_DAYS).toBe(3);
    expect(silenceThresholdDays(NUDGE_AFTER_DAYS, 1)).toBeGreaterThanOrEqual(
      EARLIEST_SILENCE_DAYS,
    );
  });
});
