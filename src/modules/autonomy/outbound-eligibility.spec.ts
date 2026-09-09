import {
  judgeOutbound,
  OUTBOUND_SPACING_DAYS,
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
