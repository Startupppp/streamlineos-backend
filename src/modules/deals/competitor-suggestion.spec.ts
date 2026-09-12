import {
  confirmedByPerson,
  evidenceQuoteFor,
  proposeCompetitors,
  EVIDENCE_QUOTE_MAX_CHARS,
  MAX_PROPOSALS_PER_SCAN,
  type CompetitorVocabularyTerm,
  type ScannedActivity,
} from "./competitor-suggestion";

/**
 * CRM-P2-12. The half of the feature that can be argued with on paper.
 *
 * The e2e spec proves a suggestion cannot be applied without a person; these
 * prove the thing one level down — that the system only ever proposes names the
 * organisation already maintains, and that "accepted" needs the reviewer to
 * agree with what they were actually shown.
 */

const vocabulary: CompetitorVocabularyTerm[] = [
  { competitorKey: "zoho", label: "Zoho CRM" },
  { competitorKey: "ace", label: "Ace Systems" },
  { competitorKey: "Salesforce", label: "Salesforce" },
];

function activity(activityId: string, body: string, subject: string | null = null): ScannedActivity {
  return { activityId, subject, body };
}

describe("proposeCompetitors", () => {
  it("proposes only names the organisation already maintains", () => {
    const proposals = proposeCompetitors(
      vocabulary,
      [activity("a1", "They are also looking at Salesforce and at Pipedrive.")],
      new Set(),
    );

    /**
     * Pipedrive is in the sentence and is not in the vocabulary, so it is not
     * proposed. This is the safety property the whole design rests on: the
     * matcher recognises, it never names.
     */
    expect(proposals.map((p) => p.competitorKey)).toEqual(["Salesforce"]);
  });

  it("matches the label as well as the stored key", () => {
    const proposals = proposeCompetitors(
      vocabulary,
      [activity("a1", "The incumbent is Zoho CRM, renewing in March.")],
      new Set(),
    );

    expect(proposals).toHaveLength(1);
    /** Found by label, filed under the key everything else in the product uses. */
    expect(proposals[0]?.competitorKey).toBe("zoho");
  });

  it("will not fire on a name buried inside another word", () => {
    const proposals = proposeCompetitors(
      vocabulary,
      [activity("a1", "That timeline is acceptable to their finance team.")],
      new Set(),
    );

    /** "ace" inside "acceptable" is the failure a substring match would produce. */
    expect(proposals).toEqual([]);
  });

  it("carries the line that named them, not a summary", () => {
    const [proposal] = proposeCompetitors(
      vocabulary,
      [
        activity(
          "a1",
          "Budget is signed off. They said Salesforce quoted them half of ours. We meet Friday.",
        ),
      ],
      new Set(),
    );

    expect(proposal?.evidenceQuote).toBe("They said Salesforce quoted them half of ours.");
    expect(proposal?.sourceActivityId).toBe("a1");
  });

  it("skips a name already recorded on the deal", () => {
    const proposals = proposeCompetitors(
      vocabulary,
      [activity("a1", "Still up against Salesforce.")],
      new Set(["Salesforce"]),
    );

    expect(proposals).toEqual([]);
  });

  it("proposes each name once, against the newest activity that mentions it", () => {
    const proposals = proposeCompetitors(
      vocabulary,
      [
        activity("newest", "Salesforce came up again today."),
        activity("older", "First mention of Salesforce."),
      ],
      new Set(),
    );

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.sourceActivityId).toBe("newest");
  });

  it("reads the subject as well as the body", () => {
    const proposals = proposeCompetitors(
      vocabulary,
      [activity("a1", "No detail recorded.", "Call: Salesforce comparison")],
      new Set(),
    );

    expect(proposals.map((p) => p.competitorKey)).toEqual(["Salesforce"]);
  });

  it("stops at the per-scan cap", () => {
    const many: CompetitorVocabularyTerm[] = Array.from(
      { length: MAX_PROPOSALS_PER_SCAN + 5 },
      (_, index) => ({ competitorKey: `rival${index}`, label: `Rival ${index}` }),
    );
    const text = many.map((term) => `We heard about ${term.competitorKey}.`).join(" ");

    const proposals = proposeCompetitors(many, [activity("a1", text)], new Set());

    expect(proposals).toHaveLength(MAX_PROPOSALS_PER_SCAN);
  });

  it("says nothing when the organisation keeps no competitor list", () => {
    const proposals = proposeCompetitors(
      [],
      [activity("a1", "They mentioned Salesforce twice.")],
      new Set(),
    );

    expect(proposals).toEqual([]);
  });
});

describe("evidenceQuoteFor", () => {
  it("trims a long sentence rather than cutting mid-quote silently", () => {
    const long = `${"word ".repeat(120)}Salesforce.`;
    const quote = evidenceQuoteFor(long, long.indexOf("Salesforce"));

    expect(quote.length).toBeLessThanOrEqual(EVIDENCE_QUOTE_MAX_CHARS);
    expect(quote.endsWith("…")).toBe(true);
  });
});

describe("confirmedByPerson", () => {
  it("mints a confirmation naming the actor and the key they agreed to", () => {
    const confirmation = confirmedByPerson({ userId: "u1" }, "zoho", "zoho");

    expect(confirmation?.actorUserId).toBe("u1");
    expect(confirmation?.confirmedCompetitorKey).toBe("zoho");
  });

  it("refuses when the reviewer echoes a different name from the stored one", () => {
    /**
     * The stale-screen case. Accepting by id alone would let a click land on a
     * proposal whose text has moved underneath it, and a click is exactly what
     * this ticket refuses to treat as consent.
     */
    expect(confirmedByPerson({ userId: "u1" }, "zoho", "Salesforce")).toBeNull();
  });
});
