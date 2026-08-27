import {
  assessPromotion,
  promoteCorrections,
  toPromotedCase,
  type CorrectionRow,
} from "./correction-promotion";

function correction(over: Partial<CorrectionRow> = {}): CorrectionRow {
  return {
    autonomyCorrectionId: "c1",
    organizationId: "org-1",
    kind: "stage.advanced",
    correctionType: "edit",
    field: "stage",
    systemValue: "PROPOSAL",
    humanValue: "QUALIFIED",
    reason: null,
    consented: true,
    promotedAt: null,
    ...over,
  };
}

/*
  The refusals are the point of this module, so they are tested first. A
  promotion path that quietly takes everything it is given is how customer data
  ends up in an evaluation dataset nobody agreed to.
*/
describe("what may not be promoted", () => {
  it("refuses a correction nobody consented to, however instructive", () => {
    const verdict = assessPromotion(correction({ consented: false }));
    expect(verdict.promotable).toBe(false);
    expect(verdict.refusal).toBe("not-consented");
  });

  it("checks consent before anything else, so a good case cannot smuggle itself in", () => {
    // Unconsented AND already promoted AND unchanged. The reason given is the
    // one that is not ours to weigh.
    const verdict = assessPromotion(
      correction({ consented: false, promotedAt: new Date(), humanValue: "PROPOSAL" }),
    );
    expect(verdict.refusal).toBe("not-consented");
  });

  it("refuses a row already promoted, so a case cannot be counted twice", () => {
    expect(assessPromotion(correction({ promotedAt: new Date() })).refusal).toBe("already-promoted");
  });

  it("refuses a reversal that says the system was wrong without saying what is right", () => {
    expect(assessPromotion(correction({ correctionType: "reversal", humanValue: null })).refusal)
      .toBe("no-human-value");
    expect(assessPromotion(correction({ humanValue: "   " })).refusal).toBe("no-human-value");
  });

  it("refuses an edit that changed nothing", () => {
    expect(assessPromotion(correction({ humanValue: "PROPOSAL", systemValue: "PROPOSAL" })).refusal)
      .toBe("unchanged");
  });

  it("returns null rather than a half-built case when it refuses", () => {
    expect(toPromotedCase(correction({ consented: false }))).toBeNull();
  });
});

describe("what a promoted case carries", () => {
  it("makes the human's answer the expected output, and the system's the input", () => {
    const promoted = toPromotedCase(correction({ reason: "they had not signed yet" }))!;
    expect(promoted.expected).toBe("QUALIFIED");
    expect(promoted.systemValue).toBe("PROPOSAL");
    expect(promoted.note).toBe("they had not signed yet");
  });

  it("traces every case back to the correction it came from", () => {
    expect(toPromotedCase(correction({ autonomyCorrectionId: "c-42" }))!.sourceCorrectionId)
      .toBe("c-42");
  });
});

describe("a promotion run accounts for everything it was given", () => {
  it("reports why the rest were refused, rather than dropping them silently", () => {
    const result = promoteCorrections([
      correction({ autonomyCorrectionId: "a" }),
      correction({ autonomyCorrectionId: "b", consented: false }),
      correction({ autonomyCorrectionId: "c", consented: false }),
      correction({ autonomyCorrectionId: "d", promotedAt: new Date() }),
      correction({ autonomyCorrectionId: "e", humanValue: null }),
      correction({ autonomyCorrectionId: "f", humanValue: "PROPOSAL" }),
    ]);

    expect(result.cases.map((c) => c.sourceCorrectionId)).toEqual(["a"]);
    expect(result.refused).toEqual({
      "not-consented": 2,
      "already-promoted": 1,
      "no-human-value": 1,
      unchanged: 1,
    });
  });

  it("promotes nothing from an empty batch without complaining", () => {
    const result = promoteCorrections([]);
    expect(result.cases).toEqual([]);
    expect(Object.values(result.refused).every((n) => n === 0)).toBe(true);
  });
});
