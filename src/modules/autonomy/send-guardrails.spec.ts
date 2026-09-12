import {
  evaluateGuardrails,
  exceedsFrequencyCap,
  guardrailSummary,
  MAX_WORKING_HOUR_DEFERRALS,
  PARTY_FREQUENCY_CAPS,
  resolveTimezone,
  sendsWithin,
  type SendTimeFacts,
} from "./send-guardrails";
import { updateAutonomySettingsSchema } from "./dto/autonomy-review.schemas";

/** A Wednesday, 10:00 UTC — inside the window in London and in Berlin. */
const NOW = new Date("2026-08-26T10:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

function facts(overrides: Partial<SendTimeFacts> = {}): SendTimeFacts {
  return {
    now: NOW,
    outboundClass: "follow_up",
    partyDeleted: false,
    consent: "UNKNOWN",
    consentExpiresAt: null,
    suppressed: false,
    classStopped: false,
    recentSendsToParty: [],
    partyTimezone: null,
    tenantTimezone: "Europe/London",
    repliedAt: null,
    draftedAt: daysAgo(1),
    dealState: "open",
    deferralsSoFar: 0,
    ...overrides,
  };
}

describe("evaluateGuardrails — the allowed case", () => {
  it("allows a message inside the window to a party who has not objected", () => {
    expect(evaluateGuardrails(facts())).toEqual({
      allow: true,
      timezoneUsed: "Europe/London",
      timezoneSource: "tenant",
    });
  });

  it("does not treat UNKNOWN consent as a block — the legal basis may be contract", () => {
    expect(evaluateGuardrails(facts({ consent: "UNKNOWN" })).allow).toBe(true);
  });
});

/**
 * A party can be soft-deleted, merged away, or erased while a message sits in
 * its hold window. Nothing that places a hold re-checks the party still
 * exists, so this has to be a send-time fact like every other one here.
 */
describe("evaluateGuardrails — a party deleted while it waited", () => {
  it("blocks a pending send to a party that no longer exists", () => {
    expect(evaluateGuardrails(facts({ partyDeleted: true }))).toEqual({
      allow: false,
      action: "block",
      reason: "party-deleted",
    });
  });

  it("allows the same message when the party is not deleted", () => {
    expect(evaluateGuardrails(facts({ partyDeleted: false })).allow).toBe(true);
  });

  /**
   * Checked first, ahead of consent and suppression both. Those two are about
   * whether this party wants the message; this one is about whether there is
   * still a party there to have an opinion at all.
   */
  it("blocks on the deletion ahead of every other reason", () => {
    expect(
      evaluateGuardrails(
        facts({
          partyDeleted: true,
          suppressed: true,
          consent: "OPTED_OUT",
          classStopped: true,
        }),
      ),
    ).toEqual({ allow: false, action: "block", reason: "party-deleted" });
  });
});

describe("evaluateGuardrails — consent, read at send time", () => {
  it("blocks an opt-out", () => {
    expect(evaluateGuardrails(facts({ consent: "OPTED_OUT" }))).toEqual({
      allow: false,
      action: "block",
      reason: "opted-out",
    });
  });

  /**
   * The criterion in the ticket's own words: a preference changed during the
   * hold window wins. The draft was composed while consent was OPTED_IN; the
   * only reading that matters is this one.
   */
  it("blocks a preference withdrawn during the hold window", () => {
    const composed = facts({ consent: "OPTED_IN" });
    expect(evaluateGuardrails(composed).allow).toBe(true);

    const atSendTime = { ...composed, consent: "OPTED_OUT" as const };
    expect(evaluateGuardrails(atSendTime)).toEqual({
      allow: false,
      action: "block",
      reason: "opted-out",
    });
  });

  it("blocks an opt-in that expired one second ago", () => {
    expect(
      evaluateGuardrails(
        facts({ consent: "OPTED_IN", consentExpiresAt: new Date(NOW.getTime() - 1000) }),
      ),
    ).toEqual({ allow: false, action: "block", reason: "consent-expired" });
  });

  it("blocks an opt-in expiring at the exact instant of the send", () => {
    expect(
      evaluateGuardrails(facts({ consent: "OPTED_IN", consentExpiresAt: NOW })),
    ).toEqual({ allow: false, action: "block", reason: "consent-expired" });
  });

  it("allows an opt-in that expires one second from now", () => {
    expect(
      evaluateGuardrails(
        facts({ consent: "OPTED_IN", consentExpiresAt: new Date(NOW.getTime() + 1000) }),
      ).allow,
    ).toBe(true);
  });

  it("blocks a suppressed address ahead of everything else", () => {
    expect(
      evaluateGuardrails(facts({ suppressed: true, consent: "OPTED_IN", classStopped: true })),
    ).toEqual({ allow: false, action: "block", reason: "suppressed" });
  });
});

describe("evaluateGuardrails — the class stop", () => {
  it("blocks the whole class for that party, not just the instance", () => {
    expect(evaluateGuardrails(facts({ classStopped: true }))).toEqual({
      allow: false,
      action: "block",
      reason: "class-stopped",
    });
  });

  it("does not block a different class that nobody stopped", () => {
    expect(
      evaluateGuardrails(facts({ outboundClass: "check_in", classStopped: false })).allow,
    ).toBe(true);
  });
});

describe("evaluateGuardrails — what changed while it waited", () => {
  it("blocks when a reply arrived after the draft", () => {
    expect(
      evaluateGuardrails(facts({ draftedAt: daysAgo(1), repliedAt: new Date(NOW.getTime() - 60_000) })),
    ).toEqual({ allow: false, action: "block", reason: "reply-arrived" });
  });

  it("blocks when the reply landed one second into the hold window", () => {
    const draftedAt = daysAgo(1);
    expect(
      evaluateGuardrails(
        facts({ draftedAt, repliedAt: new Date(draftedAt.getTime() + 1000) }),
      ),
    ).toEqual({ allow: false, action: "block", reason: "reply-arrived" });
  });

  it("ignores a reply that predates the draft — the draft already knew", () => {
    const draftedAt = daysAgo(1);
    expect(
      evaluateGuardrails(
        facts({ draftedAt, repliedAt: new Date(draftedAt.getTime() - 1000) }),
      ).allow,
    ).toBe(true);
  });

  it("blocks when the deal closed while it waited", () => {
    expect(evaluateGuardrails(facts({ dealState: "won" }))).toEqual({
      allow: false,
      action: "block",
      reason: "deal-closed",
    });
    expect(evaluateGuardrails(facts({ dealState: "lost" }))).toEqual({
      allow: false,
      action: "block",
      reason: "deal-closed",
    });
  });
});

describe("frequency caps — per party, across every loop", () => {
  it("counts only sends inside the window", () => {
    const sends = [daysAgo(1), daysAgo(4), daysAgo(20), daysAgo(400)];
    expect(sendsWithin(sends, NOW, 5)).toBe(2);
    expect(sendsWithin(sends, NOW, 30)).toBe(3);
  });

  it("blocks a second message inside five days", () => {
    expect(evaluateGuardrails(facts({ recentSendsToParty: [daysAgo(2)] }))).toEqual({
      allow: false,
      action: "block",
      reason: "frequency-cap",
    });
  });

  it("blocks a fourth message inside thirty days", () => {
    expect(
      evaluateGuardrails(
        facts({ recentSendsToParty: [daysAgo(8), daysAgo(16), daysAgo(24)] }),
      ),
    ).toEqual({ allow: false, action: "block", reason: "frequency-cap" });
  });

  it("allows a message once both windows have room", () => {
    expect(
      evaluateGuardrails(facts({ recentSendsToParty: [daysAgo(8), daysAgo(24)] })).allow,
    ).toBe(true);
  });

  /**
   * The criterion, stated as the failure it prevents: four loops, one message
   * each, all inside a week. Each is polite; the customer got four.
   */
  it("stops four loops each politely sending one", () => {
    const fromFourLoops = [daysAgo(0.5), daysAgo(1), daysAgo(2), daysAgo(3)];
    expect(exceedsFrequencyCap(fromFourLoops, NOW)).toBe(true);
    expect(evaluateGuardrails(facts({ recentSendsToParty: fromFourLoops }))).toEqual({
      allow: false,
      action: "block",
      reason: "frequency-cap",
    });
  });

  it("counts a send from another class against the same cap", () => {
    expect(
      evaluateGuardrails(
        facts({ outboundClass: "meeting_request", recentSendsToParty: [daysAgo(1)] }),
      ),
    ).toEqual({ allow: false, action: "block", reason: "frequency-cap" });
  });
});

describe("working hours — the party's clock where known", () => {
  it("uses the party's zone when the runtime recognises it", () => {
    expect(resolveTimezone({ partyTimezone: "America/Denver", tenantTimezone: "Europe/London" }))
      .toEqual({ timeZone: "America/Denver", source: "party" });
  });

  it("falls back to the tenant's when the party has none", () => {
    expect(resolveTimezone({ partyTimezone: null, tenantTimezone: "Asia/Kolkata" })).toEqual({
      timeZone: "Asia/Kolkata",
      source: "tenant",
    });
  });

  it("falls back to the tenant's — not UTC — on a zone an import invented", () => {
    expect(
      resolveTimezone({ partyTimezone: "Mars/Olympus_Mons", tenantTimezone: "Asia/Kolkata" }),
    ).toEqual({ timeZone: "Asia/Kolkata", source: "tenant" });
  });

  it("defers a send that is inside our day and the middle of their night", () => {
    const verdict = evaluateGuardrails(
      facts({ partyTimezone: "America/Los_Angeles", tenantTimezone: "Europe/London" }),
    );

    expect(verdict).toMatchObject({
      allow: false,
      action: "defer",
      reason: "outside-working-hours",
      timezoneUsed: "America/Los_Angeles",
      timezoneSource: "party",
    });
    if (verdict.allow === false && verdict.action === "defer")
      expect(verdict.notBefore.toISOString()).toBe("2026-08-26T16:00:00.000Z");
  });

  it("allows the same instant for a party whose own morning it is", () => {
    expect(
      evaluateGuardrails(facts({ partyTimezone: "Europe/Berlin" })),
    ).toEqual({ allow: true, timezoneUsed: "Europe/Berlin", timezoneSource: "party" });
  });

  it("blocks rather than defers a message it has already put off twice", () => {
    expect(
      evaluateGuardrails(
        facts({
          partyTimezone: "America/Los_Angeles",
          deferralsSoFar: MAX_WORKING_HOUR_DEFERRALS,
        }),
      ),
    ).toEqual({ allow: false, action: "block", reason: "deferred-too-often" });
  });

  it("reports an opt-out rather than deferring it to a time it must never send", () => {
    expect(
      evaluateGuardrails(
        facts({ partyTimezone: "America/Los_Angeles", consent: "OPTED_OUT" }),
      ),
    ).toEqual({ allow: false, action: "block", reason: "opted-out" });
  });
});

describe("none of these are settings a tenant can override", () => {
  /**
   * The fifth criterion, pinned rather than asserted in prose. The way a rule
   * like this dies is that somebody adds an override for one customer and the
   * next reader takes the override for the rule.
   */
  it("rejects every key that would let a tenant reach one of these rules", () => {
    const attempts = [
      { frequencyCapPerParty: 99 },
      { workingHoursStartHour: 0 },
      { workingHoursEndHour: 24 },
      { workingHoursDays: [1, 2, 3, 4, 5, 6, 7] },
      { requireConsent: false },
      { honourSuppression: false },
      { classStopsEnabled: false },
      { outboundTimezone: "UTC" },
    ];

    for (const attempt of attempts)
      expect(updateAutonomySettingsSchema.safeParse(attempt).success).toBe(false);
  });

  it("rejects an override smuggled in beside a key that is legitimate", () => {
    expect(
      updateAutonomySettingsSchema.safeParse({
        shadowDailyCap: 100,
        frequencyCapPerParty: 99,
      }).success,
    ).toBe(false);
  });

  it("still accepts the three dials that ARE a tenant's to set", () => {
    expect(
      updateAutonomySettingsSchema.safeParse({
        shadowSampleRate: 0.2,
        shadowDailyCap: 100,
        holdWindowSeconds: 120,
      }).success,
    ).toBe(true);
  });

  it("keeps the caps as module constants rather than function arguments", () => {
    expect(PARTY_FREQUENCY_CAPS).toEqual([
      { windowDays: 5, max: 1 },
      { windowDays: 30, max: 3 },
    ]);
    // One argument, and it is a snapshot of the world rather than a policy.
    expect(evaluateGuardrails).toHaveLength(1);
  });
});

describe("guardrailSummary", () => {
  it("has a sentence for every block reason", () => {
    const reasons = [
      "party-deleted",
      "suppressed",
      "opted-out",
      "consent-expired",
      "class-stopped",
      "reply-arrived",
      "deal-closed",
      "frequency-cap",
      "deferred-too-often",
    ] as const;

    for (const reason of reasons) expect(guardrailSummary(reason).length).toBeGreaterThan(10);
  });
});
