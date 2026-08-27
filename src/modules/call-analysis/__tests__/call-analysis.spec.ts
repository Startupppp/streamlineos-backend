import { assembleAnalysis, needsAnalysis, type AnalysisInput } from "../call-analysis";
import { attributeCall } from "../call-analysis-attribution";
import { mentionedCompetitors } from "../competitor-mentions";
import { ANALYSER_VERSION, digestOf } from "../transcript";
import type { CallJudgement } from "../call-judgement.schemas";

const TRANSCRIPT = [
  "Agent: Thanks for the time. What's driving the search?",
  "Customer: Honestly we're also talking to Northwind about this.",
  "Agent: Understood. I'll send the comparison over tomorrow.",
].join("\n");

const JUDGEMENT: CallJudgement = {
  objections: [{ theme: "incumbent", quote: "we're also talking to Northwind", handling: "addressed" }],
  nextStepCommitted: true,
  nextStepQuote: "I'll send the comparison over tomorrow",
};

function input(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    activityId: "act-1",
    partyId: "party-1",
    repUserId: "user-1",
    occurredAt: new Date("2026-08-20T09:00:00.000Z"),
    sourceText: TRANSCRIPT,
    judgement: JUDGEMENT,
    location: { jurisdiction: "GB", basis: "counterparty-number", regime: "one-party" },
    consentStatus: "UNKNOWN",
    competitorKeys: ["Northwind", "Contoso"],
    ...overrides,
  };
}

describe("needsAnalysis — the cache that decides the bill", () => {
  it("analyses a call nothing has been stored for", () => {
    expect(needsAnalysis(null, TRANSCRIPT)).toBe(true);
  });

  it("does not analyse an unchanged transcript a second time", () => {
    expect(
      needsAnalysis(
        { sourceDigest: digestOf(TRANSCRIPT), analyserVersion: ANALYSER_VERSION },
        TRANSCRIPT,
      ),
    ).toBe(false);
  });

  it("analyses again when the transcript itself changed", () => {
    expect(
      needsAnalysis(
        { sourceDigest: digestOf(TRANSCRIPT), analyserVersion: ANALYSER_VERSION },
        `${TRANSCRIPT}\nCustomer: One more thing.`,
      ),
    ).toBe(true);
  });

  it("analyses again when the analyser moved on, even though the text did not", () => {
    /**
     * Hashing only the transcript would pin every organisation to whichever
     * analyser first read its calls, so a corrected prompt could never reach the
     * calls it was written for.
     */
    expect(
      needsAnalysis(
        { sourceDigest: digestOf(TRANSCRIPT), analyserVersion: ANALYSER_VERSION - 1 },
        TRANSCRIPT,
      ),
    ).toBe(true);
  });

});

describe("assembleAnalysis", () => {
  it("carries the jurisdiction determination and its basis onto the record", () => {
    // Ticket 03's third criterion. A regulator asking why a call was recorded is
    // asking exactly which of the two determinations this was.
    expect(
      assembleAnalysis(
        input({
          location: { jurisdiction: "DE", basis: "counterparty-number", regime: "all-party" },
          consentStatus: "OPTED_IN",
        }),
      ),
    ).toMatchObject({
      jurisdiction: "DE",
      jurisdictionBasis: "counterparty-number",
      consentRegime: "all-party",
      consentStatus: "OPTED_IN",
    });
  });

  it("keeps only the competitors this organisation actually tracks", () => {
    const analysis = assembleAnalysis(input());
    expect(analysis.competitorKeys).toEqual(["Northwind"]);
  });

  it("drops the quote when nothing was committed", () => {
    /**
     * A quote sitting beside `nextStepCommitted: false` reads on a screen as the
     * next step, which is how "we should talk again" becomes a pipeline entry.
     */
    const analysis = assembleAnalysis(
      input({
        judgement: {
          objections: [],
          nextStepCommitted: false,
          nextStepQuote: "we should probably talk again",
        },
      }),
    );

    expect(analysis.nextStepQuote).toBeNull();
  });

  it("stamps the digest of exactly the text it read", () => {
    expect(assembleAnalysis(input()).sourceDigest).toBe(digestOf(TRANSCRIPT));
  });
});

describe("mentionedCompetitors", () => {
  it("does not find a competitor inside an unrelated word", () => {
    expect(mentionedCompetitors("we use the acmestore platform", ["Acme"])).toEqual([]);
  });

  it("counts an overlapping pair once, under the longer name", () => {
    // An organisation tracking both "Acme" and "Acme Cloud" would otherwise see
    // every mention of the latter reported as two competitive situations.
    expect(
      mentionedCompetitors("we're evaluating Acme Cloud at the moment", ["Acme", "Acme Cloud"]),
    ).toEqual(["Acme Cloud"]);
  });

  it("finds nothing when the organisation tracks nobody", () => {
    expect(mentionedCompetitors("we're evaluating Northwind", [])).toEqual([]);
  });
});

describe("attributeCall", () => {
  it("attributes a call to the person who logged it", () => {
    expect(
      attributeCall({ actorKind: "human", actorUserId: "u-1", assigneeUserId: "u-2" }),
    ).toEqual({ repUserId: "u-1", basis: "logged-by" });
  });

  it("leaves an ingested call attributed to nobody rather than to the assignee's manager", () => {
    /**
     * The finding rather than a gap. `inbound-ingress.workflow.ts` files a call
     * as `actorKind: "system"` with no user, because the party it resolves is the
     * customer. Guessing a rep here would put somebody else's call on a person's
     * coaching record.
     */
    expect(
      attributeCall({ actorKind: "system", actorUserId: null, assigneeUserId: null }),
    ).toEqual({ repUserId: null, basis: "unattributed" });
  });

  it("does not read a system actor's user id as the rep", () => {
    expect(
      attributeCall({ actorKind: "system", actorUserId: "u-9", assigneeUserId: null }).repUserId,
    ).toBeNull();
  });
});
