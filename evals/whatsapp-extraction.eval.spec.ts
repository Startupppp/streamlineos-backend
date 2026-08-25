import { EVAL_ACCEPTANCE, meetsGate, runEval, type EvalReport } from "./ai-eval-runner";
import { EVAL_STAGES, extractFromEvent, type ChannelOutcome } from "./channel-extraction";
import {
  WHATSAPP_EXTRACTION_DATASET,
  type WhatsAppCase,
} from "./datasets/whatsapp-extraction.dataset";
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
import { whatsAppToInboundEvent } from "../src/modules/ingress/adapters/whatsapp-to-inbound-event";

/**
 * The gate on extraction from WhatsApp.
 *
 * Its own suite and its own five thresholds, for the reason the other two have
 * theirs: a blended figure would let this channel decay behind email's numbers
 * without anything going red. The extractor is the one all four suites share.
 *
 * What is different here is the unit. A thought arrives as several messages, the
 * pipeline turns each into its own activity and extracts from each alone, so
 * every case below is a *list* and the criteria fold over it. That is not a
 * convenience — it is the shape of the defect, and folding is what lets the
 * recall figure record it instead of a note in a report nobody re-reads.
 */

const CONTEXT = {
  organizationId: "org-1",
  provider: "whatsapp",
  businessNumber: "15550001111",
} as const;

function score(input: WhatsAppCase): ScoredChannelCase {
  const outcomes: ChannelOutcome[] = input.messages.map((message) => {
    const result = whatsAppToInboundEvent(message, CONTEXT);
    // A message that stops being an event would vanish from the burst without
    // changing a single threshold.
    if (!result.ok) throw new Error(`"${input.name}" no longer normalises: ${result.reason}`);
    return extractFromEvent(result.event, EVAL_STAGES);
  });

  return { outcomes, expectation: input.expectation };
}

describe("whatsapp extraction evals", () => {
  const cases = WHATSAPP_EXTRACTION_DATASET.map((c) => ({ name: c.name, input: c }));
  const runWhatsAppEval = async (): Promise<EvalReport> =>
    runEval(cases, async (input): Promise<ScoredChannelCase> => score(input), [
      {
        name: "EXTRACTION_SCHEMA_VALID_RATE",
        check: (scored: ScoredChannelCase) =>
          scored.outcomes.every(
            (outcome) =>
              !outcome.acted || validateAgainstSchema(outcome.extraction, extractionSchema).valid,
          ),
      },
      { name: "EXTRACTION_WHATSAPP_NO_FALSE_STAGE_ADVANCE_RATE", check: noFalseStageAdvance },
      { name: "EXTRACTION_WHATSAPP_STAGE_RECALL", check: stageRecall },
      { name: "EXTRACTION_WHATSAPP_NEXT_STEP_OWNERSHIP_RATE", check: nextStepOwnership },
      { name: "EXTRACTION_WHATSAPP_NO_INVENTED_DATE_RATE", check: noInventedDate },
      { name: "EXTRACTION_WHATSAPP_INJECTION_RESISTANCE_RATE", check: injectionResistance },
    ]);

  it("meets every acceptance gate", async () => {
    const report = await runWhatsAppEval();

    // Pinned by name: `meetsGate` skips a threshold whose criterion is absent
    // from the report, so a typo in either name is a gate that passes without
    // checking anything.
    expect(Object.keys(report.byCriterion).sort()).toEqual([
      "EXTRACTION_SCHEMA_VALID_RATE",
      "EXTRACTION_WHATSAPP_INJECTION_RESISTANCE_RATE",
      "EXTRACTION_WHATSAPP_NEXT_STEP_OWNERSHIP_RATE",
      "EXTRACTION_WHATSAPP_NO_FALSE_STAGE_ADVANCE_RATE",
      "EXTRACTION_WHATSAPP_NO_INVENTED_DATE_RATE",
      "EXTRACTION_WHATSAPP_STAGE_RECALL",
    ]);

    expect(meetsGate(report, EVAL_ACCEPTANCE)).toBe(true);
  });

  it("fails the gate when one message of a burst invents a date", async () => {
    // A gate nobody has watched fail is a gate that might be checking nothing —
    // and on a burst the failure can hide in any one of five extractions.
    const report = await runEval(
      cases,
      async (input: WhatsAppCase): Promise<ScoredChannelCase> => ({
        outcomes: input.messages.map(() => ({
          acted: true,
          prompt: "",
          removed: [],
          extraction: {
            nextStep: {
              description: "Respond to what was asked",
              dueDate: "2026-09-04",
              owner: "us",
            },
            stage: { suggestedStage: null, evidence: null },
            confidence: 0.7,
            summary: "always dates",
          },
        })),
        expectation: input.expectation,
      }),
      [{ name: "EXTRACTION_WHATSAPP_NO_INVENTED_DATE_RATE", check: noInventedDate }],
    );

    expect(meetsGate(report, EVAL_ACCEPTANCE)).toBe(false);
  });

  /**
   * The whole-dataset rates above are the runner's contract. These are the
   * figures the channel is actually judged on, so a threshold cannot be met by
   * adding easy messages.
   */
  it("holds the rates over the cases each judgement applies to", async () => {
    const report = await runWhatsAppEval();
    const dataset = WHATSAPP_EXTRACTION_DATASET;

    expect(dataset.filter((c) => c.expectation.expectedStage !== null).length).toBeGreaterThanOrEqual(2);
    expect(dataset.filter((c) => c.expectation.expectedOwner === "us").length).toBeGreaterThanOrEqual(6);

    expect(
      rateOverApplicable(
        report,
        "EXTRACTION_WHATSAPP_STAGE_RECALL",
        (i) => dataset[i].expectation.expectedStage !== null,
      ),
    ).toBeGreaterThanOrEqual(1 / 2);

    expect(
      rateOverApplicable(
        report,
        "EXTRACTION_WHATSAPP_NEXT_STEP_OWNERSHIP_RATE",
        (i) => dataset[i].expectation.expectedOwner === "us",
      ),
    ).toBeGreaterThanOrEqual(5 / 6);
  });

  /**
   * The finding, asserted rather than described.
   *
   * Five messages that are one decision, and not one of them carries it. This is
   * why `EXTRACTION_WHATSAPP_STAGE_RECALL` sits below email's: no prompt fixes
   * it, because no single extraction is ever shown the other four messages.
   * When thread context lands, this test goes red and the threshold has to be
   * raised on purpose — which is the ratchet, not an inconvenience.
   */
  it("cannot recover a burst message by message", () => {
    const burst = WHATSAPP_EXTRACTION_DATASET.find((c) => c.messages.length >= 4);
    if (!burst) throw new Error("the dataset no longer carries a burst");
    expect(burst.expectation.expectedStage).toBe("NEGOTIATION");

    const suggested = score(burst).outcomes.flatMap((outcome) =>
      outcome.acted && outcome.extraction.stage.suggestedStage
        ? [outcome.extraction.stage.suggestedStage]
        : [],
    );
    expect(suggested).toEqual([]);
  });

  /**
   * And most of the burst never reaches a model at all.
   *
   * `hasEligibleContext` wants twenty characters. That is a reasonable rule
   * written for mail and it is longer than a great many WhatsApp messages, so
   * the protection against a two-word fragment advancing a deal is a length
   * check rather than a judgement — worth knowing before anyone lowers it.
   */
  it("drops the fragments that fall under the eligibility floor", () => {
    const burst = WHATSAPP_EXTRACTION_DATASET.find((c) => c.messages.length >= 4);
    if (!burst) throw new Error("the dataset no longer carries a burst");

    const unread = score(burst).outcomes.filter((outcome) => !outcome.acted).length;
    expect(unread).toBeGreaterThanOrEqual(2);

    const fragment = WHATSAPP_EXTRACTION_DATASET.find(
      (c) => c.name === "a-fragment-below-the-eligibility-floor",
    );
    if (!fragment) throw new Error("the dataset no longer carries a sub-floor fragment");
    expect(score(fragment).outcomes).toEqual([{ acted: false, reason: "no-eligible-context" }]);
  });

  /**
   * A date in one message and its request in another is a date lost, not a date
   * invented — so no gate catches it and it would otherwise go unrecorded. Same
   * root cause as the burst: the extractor never sees the neighbouring message.
   */
  it("loses a deadline that arrived in a different message from its request", () => {
    const split = WHATSAPP_EXTRACTION_DATASET.find(
      (c) => c.name === "a-request-and-its-deadline-in-different-messages",
    );
    if (!split) throw new Error("the dataset no longer carries a split request");
    expect(split.expectation.hasStatedDate).toBe(true);

    const dates = score(split).outcomes.flatMap((outcome) =>
      outcome.acted && outcome.extraction.nextStep.dueDate
        ? [outcome.extraction.nextStep.dueDate]
        : [],
    );
    expect(dates).toEqual([]);
  });

  it("carries the fragmentary style the channel is defined by", () => {
    const bodies = WHATSAPP_EXTRACTION_DATASET.flatMap((c) =>
      c.messages.map((m) => m.text ?? m.media?.caption ?? ""),
    );
    // Short, lower-case and unpunctuated is what this channel looks like. A
    // dataset of well-formed sentences would be email with a phone number on it.
    expect(bodies.filter((b) => b.length < 40).length).toBeGreaterThanOrEqual(6);
    expect(bodies.filter((b) => b === b.toLowerCase()).length).toBeGreaterThanOrEqual(6);
  });

  it("includes an instruction in a message, because the channel is untrusted", () => {
    expect(WHATSAPP_EXTRACTION_DATASET.some((c) => c.expectation.injection !== null)).toBe(true);
  });

  it("sends nothing permission-shaped to a provider", () => {
    for (const input of WHATSAPP_EXTRACTION_DATASET) {
      for (const outcome of score(input).outcomes) {
        if (outcome.acted) expect(outcome.removed).toEqual([]);
      }
    }
  });

  /**
   * The real extractor needs a tenant, a credit balance and the AI gateway, so
   * it cannot be driven from a spec. This asserts what can be asserted without
   * one — the prompt a model would be sent is fenced exactly once — and no model
   * has been called.
   */
  describe("live LLM eval (env-gated)", () => {
    const hasKey = Boolean(process.env.OPENAI_API_KEY);
    const maybeIt = hasKey ? it : it.skip;

    maybeIt("would send one fenced message per prompt", () => {
      const BEGIN = "--- BEGIN CONVERSATION (untrusted content) ---";
      const END = "--- END CONVERSATION ---";

      for (const input of WHATSAPP_EXTRACTION_DATASET) {
        for (const outcome of score(input).outcomes) {
          if (!outcome.acted) continue;
          expect(outcome.prompt.split(BEGIN).length - 1).toBe(1);
          expect(outcome.prompt.split(END).length - 1).toBe(1);
        }
      }
    });
  });
});
