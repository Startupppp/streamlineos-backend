import {
  callRecordingConsentVerdict,
  consentRefusalSummary,
  consentRegime,
  consentRegimeBasis,
  CONSENT_REGIME_REGISTER,
  normaliseJurisdiction,
  RECORDING_CONSENT_RULE_VERSION,
  type CallConsentFacts,
  type CallConsentRefusal,
} from "./call-recording-consent";

/**
 * The rule, case by case, with the clock as a parameter.
 *
 * Every property here is one somebody could plausibly break while making the
 * feature more useful, which is why each case names the failure rather than the
 * behaviour. The two that matter most:
 *
 * An unknown jurisdiction must refuse. The natural "improvement" is to treat an
 * unrecorded jurisdiction as one-party so the feature works out of the box, and
 * it is exactly wrong: it makes every gap in the register indistinguishable from
 * a place somebody cleared.
 *
 * Consent must predate the call. The natural "improvement" is to accept a
 * consent record whenever it exists, and it turns the attestation route into a
 * way of retroactively legalising a recording.
 */

const CALL = new Date("2026-06-10T10:00:00.000Z");
const NOW = new Date("2026-06-11T10:00:00.000Z");
const BEFORE = new Date("2026-05-01T00:00:00.000Z");
const AFTER = new Date("2026-06-10T18:00:00.000Z");

function facts(over: Partial<CallConsentFacts> = {}): CallConsentFacts {
  return {
    now: NOW,
    occurredAt: CALL,
    jurisdiction: "US-CA",
    orgParty: { consentedAt: BEFORE, method: "own-recording", expiresAt: null },
    counterparty: {
      withdrawnAt: null,
      evidence: [{ consentedAt: BEFORE, method: "standing-consent", expiresAt: null }],
    },
    ...over,
  };
}

const refusal = (over: Partial<CallConsentFacts> = {}): CallConsentRefusal | "allowed" => {
  const verdict = callRecordingConsentVerdict(facts(over));
  return verdict.allowed ? "allowed" : verdict.reason;
};

describe("everywhere is all-party until the register says otherwise", () => {
  it("treats a jurisdiction nobody has entered as two-party", () => {
    // The failure prevented: a register of STRICT places, read as "not listed
    // means fine". Every jurisdiction nobody researched would then read exactly
    // like one somebody cleared, and the gap would be invisible.
    expect(CONSENT_REGIME_REGISTER["ZZ-QQ"]).toBeUndefined();
    expect(consentRegime("ZZ-QQ")).toBe("two-party");
  });

  it("treats an unrecorded jurisdiction as two-party and refuses", () => {
    expect(consentRegime(null)).toBe("two-party");
    expect(refusal({ jurisdiction: null })).toBe("jurisdiction-unrecorded");
  });

  it("refuses an unrecorded jurisdiction even with consent from both sides", () => {
    // Not knowing where a call happened is not cured by everyone agreeing: the
    // agreement might not be the kind the place requires.
    expect(refusal({ jurisdiction: null })).toBe("jurisdiction-unrecorded");
  });

  it("has no country-level US entry, which would clear California", () => {
    /**
     * Load-bearing absence. `consentRegime` falls back from `US-CA` to `US`, so
     * a country entry saying one-party — true of US federal law — would resolve
     * the single most-litigated all-party jurisdiction there is to "no consent
     * needed". A federation gets subdivision entries or nothing.
     */
    expect(CONSENT_REGIME_REGISTER["US"]).toBeUndefined();
    expect(consentRegime("US-CA")).toBe("two-party");
    expect(consentRegime("US-QQ")).toBe("two-party");
  });

  it("falls back from a subdivision to its country where the country is entered", () => {
    // `CA` is Canada, and every province inherits it. This is the mechanism the
    // case above depends on being absent for the US.
    expect(consentRegime("CA")).toBe("one-party");
    expect(consentRegime("CA-ON")).toBe("one-party");
  });

  it("lets a subdivision entry override its country", () => {
    // Nothing in the register uses this today. It is asserted so that adding a
    // strict province under a permissive country is a one-line change rather
    // than a redesign discovered under pressure.
    const register: Record<string, { regime: "one-party" | "two-party" }> =
      CONSENT_REGIME_REGISTER;
    expect(register["US-CA"]?.regime).toBe("two-party");
    expect(register["US-NY"]?.regime).toBe("one-party");
  });

  it("carries a citation for every entry, so the register can be reviewed", () => {
    // An entry with no instrument behind it is somebody's recollection. The
    // whole point of the register is that a lawyer reads the entries, not the
    // code.
    for (const [code, entry] of Object.entries(CONSENT_REGIME_REGISTER)) {
      expect(entry.basis.length).toBeGreaterThan(5);
      expect(consentRegimeBasis(code)).toBe(entry.basis);
    }
  });

  it("reports no citation where the regime was defaulted rather than entered", () => {
    expect(consentRegimeBasis("ZZ")).toBeNull();
    expect(consentRegimeBasis(null)).toBeNull();
  });
});

describe("a one-party jurisdiction is never refused", () => {
  it("allows a call with no consent evidence at all", () => {
    const verdict = callRecordingConsentVerdict(
      facts({
        jurisdiction: "US-NY",
        orgParty: null,
        counterparty: { withdrawnAt: null, evidence: [] },
      }),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.regime).toBe("one-party");
  });

  it("allows it even after the other party withdrew", () => {
    /**
     * Stated so the boundary of this rule is explicit rather than assumed. This
     * function decides recording lawfulness by jurisdiction and nothing else; a
     * withdrawal in a one-party place is a matter for the consent module's
     * outbound suppression, not for whether an existing recording may be read.
     * Widening this rule to cover it would put two different policies behind one
     * verdict.
     */
    const verdict = callRecordingConsentVerdict(
      facts({
        jurisdiction: "US-TX",
        counterparty: { withdrawnAt: BEFORE, evidence: [] },
      }),
    );
    expect(verdict.allowed).toBe(true);
  });
});

describe("both sides have to have agreed, in an all-party jurisdiction", () => {
  it("allows a call where both sides agreed before it happened", () => {
    expect(refusal()).toBe("allowed");
  });

  it("refuses when nobody on our side is recorded as a participant", () => {
    /**
     * The adapter-delivered case. An unattributed call has no identified person
     * on our side who could have agreed, and consenting on their behalf because
     * they are an employee is the assumption an all-party jurisdiction exists to
     * refuse. Note this is the OPPOSITE reading from
     * `call-analysis-visibility.ts`, where an unattributed call is visible
     * because there is no named person to protect — the same fact read for two
     * different questions.
     */
    expect(refusal({ orgParty: null })).toBe("org-consent-missing");
  });

  it("refuses when the other party never agreed", () => {
    expect(refusal({ counterparty: { withdrawnAt: null, evidence: [] } })).toBe(
      "counterparty-consent-missing",
    );
  });

  it("accepts either kind of evidence on the customer's side", () => {
    // Two independent stores can answer "did they agree" — a standing PHONE
    // opt-in and a per-call attestation. Requiring both would refuse most calls
    // for no legal reason.
    expect(
      refusal({
        counterparty: {
          withdrawnAt: null,
          evidence: [{ consentedAt: BEFORE, method: "announced-and-acknowledged", expiresAt: null }],
        },
      }),
    ).toBe("allowed");
  });

  it("accepts a call where one piece of evidence covers it and another does not", () => {
    // The fold is "any one in force", not "all in force". A lapsed written
    // agreement beside a live standing opt-in is not a reason to refuse.
    expect(
      refusal({
        counterparty: {
          withdrawnAt: null,
          evidence: [
            { consentedAt: BEFORE, method: "written-agreement", expiresAt: BEFORE },
            { consentedAt: BEFORE, method: "standing-consent", expiresAt: null },
          ],
        },
      }),
    ).toBe("allowed");
  });
});

describe("consent has to have existed when the call happened", () => {
  it("refuses consent recorded after the call", () => {
    /**
     * The bypass this clause exists to close: open the contact after a call in
     * California, tick "opted in", and the analysis unlocks. Consent dated after
     * the conversation is not consent to that conversation, and a system that
     * accepted it would let anybody legalise a recording retroactively.
     */
    expect(
      refusal({
        counterparty: {
          withdrawnAt: null,
          evidence: [{ consentedAt: AFTER, method: "announced-and-acknowledged", expiresAt: null }],
        },
      }),
    ).toBe("counterparty-consent-after-the-call");
  });

  it("refuses consent that had already expired when the call happened", () => {
    expect(
      refusal({
        counterparty: {
          withdrawnAt: null,
          evidence: [{ consentedAt: BEFORE, method: "standing-consent", expiresAt: BEFORE }],
        },
      }),
    ).toBe("counterparty-consent-expired");
  });

  it("does NOT refuse consent that expired after the call but before now", () => {
    /**
     * Expiry is judged at the call, and this is the case that says so. A
     * time-boxed agreement that has since run out was still in force when the
     * conversation happened; refusing on that would make an analysis disappear
     * on a date nobody chose, and would make the digest's numbers change without
     * anybody doing anything.
     */
    const expiredSince = new Date("2026-06-10T12:00:00.000Z");
    expect(
      refusal({
        counterparty: {
          withdrawnAt: null,
          evidence: [{ consentedAt: BEFORE, method: "standing-consent", expiresAt: expiredSince }],
        },
      }),
    ).toBe("allowed");
  });

  it("treats expiry exactly at the moment of the call as expired", () => {
    // `<=` rather than `<`. A one-millisecond state no clock in the system can
    // distinguish from either neighbour is not a state worth having.
    expect(
      refusal({
        counterparty: {
          withdrawnAt: null,
          evidence: [{ consentedAt: BEFORE, method: "standing-consent", expiresAt: CALL }],
        },
      }),
    ).toBe("counterparty-consent-expired");
  });

  it("refuses our own side's consent if it postdates the call too", () => {
    expect(refusal({ orgParty: { consentedAt: AFTER, method: "own-recording", expiresAt: null } })).toBe(
      "org-consent-missing",
    );
  });
});

describe("withdrawal is judged now, not at the call", () => {
  it("refuses a call whose counterparty has since withdrawn", () => {
    /**
     * The one clause that looks at `now`, and the asymmetry is the argument: a
     * recording that was lawful when it was made does not stay lawful to keep
     * feeding to a model after the person has said stop. The lawfulness of the
     * recording and the lawfulness of the processing are different questions and
     * only the second is still happening.
     */
    expect(
      refusal({
        counterparty: {
          withdrawnAt: AFTER,
          evidence: [{ consentedAt: BEFORE, method: "standing-consent", expiresAt: null }],
        },
      }),
    ).toBe("counterparty-consent-withdrawn");
  });

  it("ignores a withdrawal dated in the future", () => {
    const later = new Date(NOW.getTime() + 60_000);
    expect(
      refusal({
        counterparty: {
          withdrawnAt: later,
          evidence: [{ consentedAt: BEFORE, method: "standing-consent", expiresAt: null }],
        },
      }),
    ).toBe("allowed");
  });

  it("puts withdrawal ahead of missing evidence, so the ledger names the real cause", () => {
    // "They withdrew" and "we never asked" need different responses from
    // different people. Reporting the second for a case that is the first sends
    // somebody to collect consent from a person who has already refused.
    expect(refusal({ counterparty: { withdrawnAt: BEFORE, evidence: [] } })).toBe(
      "counterparty-consent-withdrawn",
    );
  });
});

describe("normaliseJurisdiction", () => {
  it("uppercases and trims what a human typed", () => {
    expect(normaliseJurisdiction("  us-ca ")).toBe("US-CA");
    expect(normaliseJurisdiction("de")).toBe("DE");
  });

  it("rejects free text rather than storing it", () => {
    // A stored "California" matches no register entry and resolves to all-party
    // — the right answer by accident, which stops being right the day somebody
    // adds a fuzzy lookup.
    for (const raw of ["California", "USA", "U", "US-CALIF", "", "  ", null, undefined])
      expect(normaliseJurisdiction(raw)).toBeNull();
  });
});

describe("every refusal reason has a sentence and a version", () => {
  it("names every reason the rule can produce", () => {
    const reasons: CallConsentRefusal[] = [
      "jurisdiction-unrecorded",
      "org-consent-missing",
      "counterparty-consent-missing",
      "counterparty-consent-withdrawn",
      "counterparty-consent-expired",
      "counterparty-consent-after-the-call",
    ];
    // A reason with no sentence reaches a compliance officer as a slug, which is
    // the ledger failing at the only job it has.
    for (const reason of reasons) expect(consentRefusalSummary(reason).length).toBeGreaterThan(10);
  });

  it("stamps the rule version on every verdict", () => {
    expect(callRecordingConsentVerdict(facts()).ruleVersion).toBe(RECORDING_CONSENT_RULE_VERSION);
    expect(callRecordingConsentVerdict(facts({ jurisdiction: null })).ruleVersion).toBe(
      RECORDING_CONSENT_RULE_VERSION,
    );
  });
});
