import { EVAL_ACCEPTANCE, gatesPresentIn, meetsGate, runEval, type EvalReport } from "./ai-eval-runner";
import { EVAL_STAGES, extractFromEvent } from "./channel-extraction";
import {
  TRANSCRIPT_EXTRACTION_DATASET,
  type TranscriptCase,
} from "./datasets/transcript-extraction.dataset";
import { validateAgainstSchema } from "./scorers/schema.scorer";
import {
  injectionResistance,
  nextStepOwnership,
  noFalseStageAdvance,
  noInventedDate,
  rateOverApplicable,
  stageRecall,
  type ScoredChannelCase,
} from "./scorers/channel-extraction.scorer";
import { extractionSchema } from "../src/modules/autonomy/extraction.schemas";
import { telephonyCallToInboundEvent } from "../src/modules/ingress/adapters/telephony-to-inbound-event";

/**
 * The gate on extraction from a phone transcript.
 *
 * Its own suite, its own dataset and its own five thresholds, because the whole
 * argument for splitting these is that one blended figure hides the channel that
 * is getting worse. The extractor is shared with the other three suites, so the
 * numbers below say something about transcripts rather than about a stand-in
 * written for them.
 *
 * The call is put through `telephonyCallToInboundEvent` and then through the
 * pipeline's own steps rather than being handed to the extractor as a string.
 * That is what makes the untranscribed call scoreable: the adapter returns an
 * event with a null body, the eligibility judgement stops the pipeline, and nothing
 * is spent and nothing is written.
 */

const CONTEXT = { organizationId: "org-1", provider: "twilio" } as const;

function score(input: TranscriptCase): ScoredChannelCase {
  const result = telephonyCallToInboundEvent(input.call, CONTEXT);
  // A case that stops being an event would otherwise vanish from the denominator
  // and lift every rate below without anybody editing a threshold.
  if (!result.ok) throw new Error(`"${input.name}" no longer normalises: ${result.reason}`);

  return {
    outcomes: [extractFromEvent(result.event, EVAL_STAGES)],
    expectation: input.expectation,
  };
}

describe("transcript extraction evals", () => {
  const cases = TRANSCRIPT_EXTRACTION_DATASET.map((c) => ({ name: c.name, input: c }));
  const runTranscriptEval = async (): Promise<EvalReport> =>
    runEval(cases, async (input): Promise<ScoredChannelCase> => score(input), [
      {
        name: "EXTRACTION_SCHEMA_VALID_RATE",
        check: (scored: ScoredChannelCase) =>
          scored.outcomes.every(
            (outcome) =>
              !outcome.acted || validateAgainstSchema(outcome.extraction, extractionSchema).valid,
          ),
      },
      { name: "EXTRACTION_TRANSCRIPT_NO_FALSE_STAGE_ADVANCE_RATE", check: noFalseStageAdvance },
      { name: "EXTRACTION_TRANSCRIPT_STAGE_RECALL", check: stageRecall },
      { name: "EXTRACTION_TRANSCRIPT_NEXT_STEP_OWNERSHIP_RATE", check: nextStepOwnership },
      { name: "EXTRACTION_TRANSCRIPT_NO_INVENTED_DATE_RATE", check: noInventedDate },
      { name: "EXTRACTION_TRANSCRIPT_INJECTION_RESISTANCE_RATE", check: injectionResistance },
    ]);

  it("meets every acceptance gate", async () => {
    const report = await runTranscriptEval();

    // Pinned by name: `meetsGate` silently skips a threshold whose criterion is
    // absent from the report, so a typo in either name is a green gate that
    // checks nothing at all.
    expect(Object.keys(report.byCriterion).sort()).toEqual([
      "EXTRACTION_SCHEMA_VALID_RATE",
      "EXTRACTION_TRANSCRIPT_INJECTION_RESISTANCE_RATE",
      "EXTRACTION_TRANSCRIPT_NEXT_STEP_OWNERSHIP_RATE",
      "EXTRACTION_TRANSCRIPT_NO_FALSE_STAGE_ADVANCE_RATE",
      "EXTRACTION_TRANSCRIPT_NO_INVENTED_DATE_RATE",
      "EXTRACTION_TRANSCRIPT_STAGE_RECALL",
    ]);

    expect(meetsGate(report, gatesPresentIn(report, EVAL_ACCEPTANCE))).toBe(true);
  });

  it("fails the gate when an extractor starts advancing stages", async () => {
    // A gate nobody has watched fail is a gate that might be checking nothing.
    const report = await runEval(
      cases,
      async (input: TranscriptCase): Promise<ScoredChannelCase> => ({
        outcomes: [
          {
            acted: true,
            prompt: "",
            removed: [],
            extraction: {
              nextStep: { description: null, dueDate: null, owner: "unclear" },
              stage: { suggestedStage: "WON", evidence: null },
              confidence: 0.99,
              summary: "always advances",
            },
          },
        ],
        expectation: input.expectation,
      }),
      [
        { name: "EXTRACTION_TRANSCRIPT_NO_FALSE_STAGE_ADVANCE_RATE", check: noFalseStageAdvance },
        { name: "EXTRACTION_TRANSCRIPT_INJECTION_RESISTANCE_RATE", check: injectionResistance },
      ],
    );

    expect(meetsGate(report, gatesPresentIn(report, EVAL_ACCEPTANCE))).toBe(false);
  });

  /**
   * The thresholds above are shares of the whole dataset, which is the runner's
   * contract and the right denominator for a safety gate. It is the wrong one
   * for recall, so the figures the channel is really judged on are asserted here
   * too — otherwise ten more easy calls would lift the gate without anything
   * improving.
   */
  it("holds the rates over the cases each judgement applies to", async () => {
    const report = await runTranscriptEval();
    const dataset = TRANSCRIPT_EXTRACTION_DATASET;

    const stageCases = dataset.filter((c) => c.expectation.expectedStage !== null);
    const ourCases = dataset.filter((c) => c.expectation.expectedOwner === "us");
    expect(stageCases.length).toBeGreaterThanOrEqual(3);
    expect(ourCases.length).toBeGreaterThanOrEqual(7);

    expect(
      rateOverApplicable(
        report,
        "EXTRACTION_TRANSCRIPT_STAGE_RECALL",
        (i) => dataset[i].expectation.expectedStage !== null,
      ),
    ).toBeGreaterThanOrEqual(2 / 3);

    /**
     * Roughly half the calls that ask us for something are read as asking
     * nobody. It is the worst figure in the phase and it is written down rather
     * than averaged away: a spoken request shares almost no vocabulary with a
     * written one.
     */
    expect(
      rateOverApplicable(
        report,
        "EXTRACTION_TRANSCRIPT_NEXT_STEP_OWNERSHIP_RATE",
        (i) => dataset[i].expectation.expectedOwner === "us",
      ),
    ).toBeGreaterThanOrEqual(4 / 7);
  });

  /**
   * The behaviour the telephony adapter refused to fake, scored rather than
   * assumed. A call with no transcript has no body, so no provider is called and
   * nothing is written — and "does nothing" is a behaviour that can regress into
   * "guesses" as easily as any other.
   */
  it("does nothing at all with a call that has no transcript", () => {
    const untranscribed = TRANSCRIPT_EXTRACTION_DATASET.find((c) => c.call.transcript === null);
    if (!untranscribed) throw new Error("the dataset no longer carries an untranscribed call");

    expect(score(untranscribed).outcomes).toEqual([
      { acted: false, reason: "no-eligible-context" },
    ]);
  });

  it("carries the disfluency the channel is defined by", () => {
    const transcripts = TRANSCRIPT_EXTRACTION_DATASET.map((c) => c.call.transcript ?? "");
    // Filler words, self-correction and both people talking at once. Without
    // these the dataset is email with a phone number attached.
    expect(transcripts.filter((t) => /\bum\b|\buh\b|\bmm\b/i.test(t)).length).toBeGreaterThanOrEqual(4);
    expect(transcripts.some((t) => /sorry[ ,—-]/i.test(t))).toBe(true);
    expect(transcripts.some((t) => /go ahead/i.test(t))).toBe(true);
  });

  it("carries the dates that are not deadlines, because that is where one gets invented", () => {
    const mentionsADate = TRANSCRIPT_EXTRACTION_DATASET.filter(
      (c) => /\b(july|september|october)\b/i.test(c.call.transcript ?? ""),
    );
    expect(mentionsADate.length).toBeGreaterThanOrEqual(3);
    // And most of them state no deadline for us at all.
    expect(mentionsADate.filter((c) => !c.expectation.hasStatedDate).length).toBeGreaterThanOrEqual(2);
  });

  it("includes an instruction read down the phone, because a transcript is untrusted too", () => {
    expect(TRANSCRIPT_EXTRACTION_DATASET.some((c) => c.expectation.injection !== null)).toBe(true);
  });

  it("sends nothing permission-shaped to a provider", () => {
    for (const input of TRANSCRIPT_EXTRACTION_DATASET) {
      for (const outcome of score(input).outcomes) {
        if (outcome.acted) expect(outcome.removed).toEqual([]);
      }
    }
  });

  /**
   * The real extractor cannot be driven from a spec: it goes through the AI
   * gateway, which needs a tenant, a credit balance and a reservation. So this
   * block asserts what can be asserted without one — that the prompt a model
   * would receive still has exactly one fence around exactly the transcript —
   * and says plainly that no model has been called. A placeholder that pretended
   * to score one would be worse than an absence.
   */
  describe("live LLM eval (env-gated)", () => {
    const hasKey = Boolean(process.env.OPENAI_API_KEY);
    const maybeIt = hasKey ? it : it.skip;

    maybeIt("would send one fenced transcript per call", () => {
      const BEGIN = "--- BEGIN CONVERSATION (untrusted content) ---";
      const END = "--- END CONVERSATION ---";

      for (const input of TRANSCRIPT_EXTRACTION_DATASET) {
        for (const outcome of score(input).outcomes) {
          if (!outcome.acted) continue;
          expect(outcome.prompt.split(BEGIN).length - 1).toBe(1);
          expect(outcome.prompt.split(END).length - 1).toBe(1);
        }
      }
    });
  });
});
