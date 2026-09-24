import {
  CANDIDATE_CONSENT_PURPOSES,
  RETENTION_POLICY,
  addMonthsUtc,
  computeRetainUntil,
  decideErasure,
  isCandidateConsentPurpose,
  type ConsentFacts,
} from "./candidate-consent";

const NOW = new Date("2026-09-24T00:00:00.000Z");

const APPLIED_LAST_MONTH: ConsentFacts = {
  purpose: "THIS_ROLE_ONLY",
  consentAt: new Date("2026-08-01T00:00:00.000Z"),
  lastActivityAt: new Date("2026-08-20T00:00:00.000Z"),
  retainUntil: null,
};

describe("decideErasure — a record inside its retention window is not erasable", () => {
  /**
   * The load-bearing test. Erasure is irreversible and destroys the evidence
   * that a hiring decision was lawful, so a record the candidate was told would
   * be kept until a given date must survive every sweep until that date.
   */
  it("refuses to erase a record whose retention period has not ended, and says when it will", () => {
    const decision = decideErasure(APPLIED_LAST_MONTH, NOW);

    expect(decision.decision).toBe("WITHIN_RETENTION");
    if (decision.decision !== "WITHIN_RETENTION") throw new Error("expected retention");
    // Last activity 2026-08-20 + 6 months for THIS_ROLE_ONLY.
    expect(decision.retainUntil.toISOString()).toBe("2027-02-20T00:00:00.000Z");
    expect(decision.reason).toContain("2027-02-20");
  });

  it("erases once the window has closed, naming the date it closed on", () => {
    const decision = decideErasure(APPLIED_LAST_MONTH, new Date("2027-02-21T00:00:00.000Z"));

    expect(decision.decision).toBe("ERASE_DUE");
    if (decision.decision !== "ERASE_DUE") throw new Error("expected erasure");
    expect(decision.reason).toContain("2027-02-20");
  });

  /**
   * The boundary is the thing an off-by-one gets wrong, and getting it wrong
   * here deletes somebody's record a day early.
   *
   * The retention date is the instant the period ENDS, not the last instant it
   * covers: at 2027-02-20T00:00:00Z exactly six months have elapsed since the
   * last activity, so the record is due. One millisecond earlier it is not.
   */
  it("retains up to the instant before the retention date and is due exactly on it", () => {
    const at = new Date("2027-02-20T00:00:00.000Z");
    expect(
      decideErasure(APPLIED_LAST_MONTH, new Date(at.getTime() - 1)).decision,
    ).toBe("WITHIN_RETENTION");
    expect(decideErasure(APPLIED_LAST_MONTH, at).decision).toBe("ERASE_DUE");
  });

  /**
   * A talent-pool record is the one that silently becomes "forever". It must
   * outlive the role it came from, but it must still end.
   */
  it("gives a talent-pool record a longer window than the role it applied to, but still a finite one", () => {
    const pooled: ConsentFacts = { ...APPLIED_LAST_MONTH, purpose: "FUTURE_ROLES" };

    expect(decideErasure(pooled, new Date("2027-02-21T00:00:00.000Z")).decision).toBe(
      "WITHIN_RETENTION",
    );
    expect(decideErasure(pooled, new Date("2028-08-21T00:00:00.000Z")).decision).toBe(
      "ERASE_DUE",
    );
  });
});

describe("decideErasure — an unrecognised purpose is refused, not guessed", () => {
  /**
   * The specific harm: a sweep that cannot classify a row either deletes it on
   * a default window nobody consented to, or silently keeps it forever. Both
   * are wrong, so the answer is a named refusal the sweep can count and a human
   * can action.
   */
  it("refuses a purpose that is not on the closed list, and does not erase it", () => {
    const decision = decideErasure({ ...APPLIED_LAST_MONTH, purpose: "MARKETING" }, NOW);

    expect(decision.decision).toBe("PURPOSE_NOT_RECOGNISED");
    expect(decision.reason).toContain("MARKETING");
    expect(decision.reason).toContain("review");
  });

  /**
   * An unrecognised purpose must never become erasable merely by ageing. This
   * is the version of the bug that only appears years later.
   */
  it("still refuses an unrecognised purpose long after any window would have expired", () => {
    const decision = decideErasure(
      { ...APPLIED_LAST_MONTH, purpose: "MARKETING" },
      new Date("2099-01-01T00:00:00.000Z"),
    );
    expect(decision.decision).toBe("PURPOSE_NOT_RECOGNISED");
  });

  it("refuses an empty-string purpose rather than treating it as absent", () => {
    expect(decideErasure({ ...APPLIED_LAST_MONTH, purpose: "" }, NOW).decision).toBe(
      "PURPOSE_NOT_RECOGNISED",
    );
  });

  /**
   * Today's rows: a bare `consent_at` with nothing beside it. They are the
   * reason this module exists, and they must be surfaced rather than swept.
   */
  it("refuses a pre-migration row that has a consent date but no purpose", () => {
    const decision = decideErasure({ ...APPLIED_LAST_MONTH, purpose: null }, NOW);
    expect(decision.decision).toBe("CONSENT_NOT_RECORDED");
  });

  it("refuses a row with a purpose but no consent date, having nothing to measure from", () => {
    const decision = decideErasure({ ...APPLIED_LAST_MONTH, consentAt: null }, NOW);
    expect(decision.decision).toBe("CONSENT_NOT_RECORDED");
  });

  it("recognises exactly the purposes on the closed list and nothing else", () => {
    for (const purpose of CANDIDATE_CONSENT_PURPOSES) {
      expect(isCandidateConsentPurpose(purpose)).toBe(true);
    }
    for (const notAPurpose of ["", "marketing", "this_role_only", null, undefined]) {
      expect(isCandidateConsentPurpose(notAPurpose)).toBe(false);
    }
  });
});

describe("decideErasure — a statutory record is not erased on request", () => {
  /**
   * Consent cannot be withdrawn from an obligation that does not rest on
   * consent. Erasing here would delete records the organisation is separately
   * required to produce — the mirror-image failure to keeping a rejected
   * applicant forever.
   */
  it("keeps a statutory record and says it is law rather than consent that keeps it", () => {
    const decision = decideErasure(
      { ...APPLIED_LAST_MONTH, purpose: "STATUTORY_RECORD" },
      new Date("2099-01-01T00:00:00.000Z"),
    );

    expect(decision.decision).toBe("RETAINED_BY_LAW");
    expect(decision.reason).toContain("statutory");
  });

  it("marks exactly one purpose as resting on a legal obligation", () => {
    const byLaw = CANDIDATE_CONSENT_PURPOSES.filter(
      (p) => RETENTION_POLICY[p].lawfulBasis === "LEGAL_OBLIGATION",
    );
    expect(byLaw).toEqual(["STATUTORY_RECORD"]);
  });
});

describe("decideErasure — the stored retention date never pulls a deletion forward", () => {
  /**
   * A deliberately extended window is honoured; a stored value that is somehow
   * earlier than policy allows is not, because erasing early is the
   * irreversible half of this decision.
   */
  it("honours a stored retention date later than the policy would derive", () => {
    const extended: ConsentFacts = {
      ...APPLIED_LAST_MONTH,
      retainUntil: new Date("2030-01-01T00:00:00.000Z"),
    };
    const decision = decideErasure(extended, new Date("2028-01-01T00:00:00.000Z"));

    expect(decision.decision).toBe("WITHIN_RETENTION");
    if (decision.decision !== "WITHIN_RETENTION") throw new Error("expected retention");
    expect(decision.retainUntil.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("ignores a stored retention date earlier than the policy allows", () => {
    const tooEarly: ConsentFacts = {
      ...APPLIED_LAST_MONTH,
      retainUntil: new Date("2026-09-01T00:00:00.000Z"),
    };
    const decision = decideErasure(tooEarly, NOW);

    expect(decision.decision).toBe("WITHIN_RETENTION");
    if (decision.decision !== "WITHIN_RETENTION") throw new Error("expected retention");
    expect(decision.retainUntil.toISOString()).toBe("2027-02-20T00:00:00.000Z");
  });

  /**
   * An application nobody ever touched is the likeliest thing to sit forever,
   * so it is the case that most needs a clock.
   */
  it("measures from the consent date when there is no recorded activity at all", () => {
    const untouched: ConsentFacts = { ...APPLIED_LAST_MONTH, lastActivityAt: null };
    const decision = decideErasure(untouched, NOW);

    expect(decision.decision).toBe("WITHIN_RETENTION");
    if (decision.decision !== "WITHIN_RETENTION") throw new Error("expected retention");
    // Consent 2026-08-01 + 6 months, not the activity date.
    expect(decision.retainUntil.toISOString()).toBe("2027-02-01T00:00:00.000Z");
  });
});

describe("addMonthsUtc / computeRetainUntil", () => {
  /**
   * Without the clamp, 31 January plus one month rolls into March, so the
   * length of February would decide when a résumé is deleted.
   */
  it("clamps to the end of the target month instead of rolling into the next one", () => {
    expect(addMonthsUtc(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    expect(addMonthsUtc(new Date("2028-01-31T00:00:00.000Z"), 1).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("derives the stored retention date from the same policy the sweep reads", () => {
    const from = new Date("2026-08-20T00:00:00.000Z");
    expect(computeRetainUntil("THIS_ROLE_ONLY", from).toISOString()).toBe(
      "2027-02-20T00:00:00.000Z",
    );
    expect(computeRetainUntil("FUTURE_ROLES", from).toISOString()).toBe(
      "2028-08-20T00:00:00.000Z",
    );
  });
});
