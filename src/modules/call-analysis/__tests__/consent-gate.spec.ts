import {
  analysesToErase,
  mayAnalyse,
  refusalSummary,
  type AnalysisRefusal,
  type CallConsentFacts,
} from "../consent-gate";

const NOW = new Date("2026-08-26T10:00:00.000Z");

function facts(overrides: Partial<CallConsentFacts> = {}): CallConsentFacts {
  return {
    now: NOW,
    regime: "one-party",
    hasTranscript: true,
    consent: "UNKNOWN",
    consentExpiresAt: null,
    ...overrides,
  };
}

describe("mayAnalyse — a call with nothing in it", () => {
  it("refuses a call with no transcript rather than producing an empty analysis", () => {
    /**
     * An empty analysis is worse than a missing one: it is indistinguishable
     * from a call that genuinely went nowhere, and a rep would have to argue
     * with a row of zeroes.
     */
    expect(mayAnalyse(facts({ hasTranscript: false }))).toEqual({
      mayAnalyse: false,
      reason: "no-transcript",
    });
  });

  it("refuses a call with no transcript even where consent is explicit", () => {
    expect(
      mayAnalyse(facts({ hasTranscript: false, consent: "OPTED_IN", regime: "all-party" }))
        .mayAnalyse,
    ).toBe(false);
  });
});

describe("mayAnalyse — a two-party-consent jurisdiction", () => {
  it("does not analyse a call where nobody recorded agreement", () => {
    expect(mayAnalyse(facts({ regime: "all-party", consent: "UNKNOWN" }))).toEqual({
      mayAnalyse: false,
      reason: "consent-not-given",
    });
  });

  it("analyses it once agreement is on file", () => {
    expect(mayAnalyse(facts({ regime: "all-party", consent: "OPTED_IN" })).mayAnalyse).toBe(
      true,
    );
  });

  it("treats an opt-in that has run out as no opt-in", () => {
    expect(
      mayAnalyse(
        facts({
          regime: "all-party",
          consent: "OPTED_IN",
          consentExpiresAt: new Date(NOW.getTime()),
        }),
      ),
    ).toEqual({ mayAnalyse: false, reason: "consent-expired" });
  });

  it("still allows an opt-in that expires a moment later", () => {
    expect(
      mayAnalyse(
        facts({
          regime: "all-party",
          consent: "OPTED_IN",
          consentExpiresAt: new Date(NOW.getTime() + 1),
        }),
      ).mayAnalyse,
    ).toBe(true);
  });
});

describe("mayAnalyse — a one-party-consent jurisdiction", () => {
  it("allows a call where the other side never said anything either way", () => {
    // We were a party to the conversation, which is what one-party means.
    expect(mayAnalyse(facts({ regime: "one-party", consent: "UNKNOWN" })).mayAnalyse).toBe(true);
  });

  it("still refuses a call where they told us to stop", () => {
    /**
     * The legal minimum is not the promise the product made. A one-party
     * jurisdiction makes recording lawful without their agreement; it does not
     * make it lawful after they have withdrawn it.
     */
    expect(mayAnalyse(facts({ regime: "one-party", consent: "OPTED_OUT" }))).toEqual({
      mayAnalyse: false,
      reason: "consent-withdrawn",
    });
  });

  it("does not delete an analysis because a marketing permission lapsed", () => {
    // `expiresAt` on a contact-channel consent row is a permission to contact
    // them, and reading it as a recording ban would erase analyses for a reason
    // nobody stated.
    expect(
      mayAnalyse(
        facts({
          regime: "one-party",
          consent: "OPTED_IN",
          consentExpiresAt: new Date(NOW.getTime() - 86_400_000),
        }),
      ).mayAnalyse,
    ).toBe(true);
  });
});

describe("analysesToErase — withdrawal reaches backwards", () => {
  it("removes an analysis of a call that happened months before the withdrawal", () => {
    /**
     * Ticket 03's fifth criterion. The rule is not "stop analysing their calls";
     * it is "stop holding the analysis". A withdrawal today reaches the reading
     * of a call from March, because the same predicate is asked of every row
     * already on file.
     */
    expect(
      analysesToErase(
        [
          {
            crmCallAnalysisId: "march-call",
            regime: "one-party",
            consent: "OPTED_OUT",
            consentExpiresAt: null,
          },
          {
            crmCallAnalysisId: "someone-else",
            regime: "one-party",
            consent: "UNKNOWN",
            consentExpiresAt: null,
          },
        ],
        NOW,
      ),
    ).toEqual(["march-call"]);
  });

  it("removes an all-party analysis whose consent was rolled back to unknown", () => {
    // A consent row edited back to UNKNOWN is not a withdrawal in so many words,
    // and it is one in effect: the agreement the analysis rested on is gone.
    expect(
      analysesToErase(
        [
          {
            crmCallAnalysisId: "berlin-call",
            regime: "all-party",
            consent: "UNKNOWN",
            consentExpiresAt: null,
          },
        ],
        NOW,
      ),
    ).toEqual(["berlin-call"]);
  });

  it("leaves alone every analysis the rule would still permit today", () => {
    expect(
      analysesToErase(
        [
          {
            crmCallAnalysisId: "consented",
            regime: "all-party",
            consent: "OPTED_IN",
            consentExpiresAt: null,
          },
          {
            crmCallAnalysisId: "one-party-unknown",
            regime: "one-party",
            consent: "UNKNOWN",
            consentExpiresAt: null,
          },
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it("erases exactly what the creation rule would refuse, for every combination", () => {
    /**
     * The two rules are the same rule, and this is where that is checked rather
     * than described. A future edit that relaxed erasure without relaxing
     * creation — or the reverse — would leave analyses on file that the product
     * would refuse to create today, which is the failure mode a separate
     * deletion rule always eventually produces.
     */
    const regimes = ["all-party", "one-party"] as const;
    const statuses = ["OPTED_IN", "OPTED_OUT", "UNKNOWN"] as const;

    for (const regime of regimes)
      for (const consent of statuses) {
        const wouldRefuse = !mayAnalyse(
          facts({ regime, consent, consentExpiresAt: null }),
        ).mayAnalyse;

        expect(
          analysesToErase(
            [{ crmCallAnalysisId: "row", regime, consent, consentExpiresAt: null }],
            NOW,
          ),
        ).toEqual(wouldRefuse ? ["row"] : []);
      }
  });
});

describe("refusalSummary", () => {
  it("has a sentence for every reason a call is not analysed", () => {
    const reasons: readonly AnalysisRefusal[] = [
      "no-transcript",
      "consent-withdrawn",
      "consent-not-given",
      "consent-expired",
    ];

    for (const reason of reasons) expect(refusalSummary(reason).length).toBeGreaterThan(10);
  });
});
