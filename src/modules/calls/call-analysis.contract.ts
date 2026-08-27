import { z } from "zod";
import { OBJECTION_HANDLINGS } from "../../db/schema/crm/call-analysis";
import type { DiarisedTranscript } from "./transcript-metrics";

/**
 * The one thing the model is asked for, and the boundary around it.
 *
 * Two rules shape every field below.
 *
 * The model is asked only for judgements. Which speaker is ours, what a
 * customer objected to, whether a rival was named, whether anybody committed to
 * a next step — none of those can be computed, and all of them are what a sales
 * manager actually wants. Arithmetic is not here: talk ratio and question count
 * are counted in `transcript-metrics.ts`, so they are reproducible and so that
 * re-reading a cached row and re-deriving from the transcript cannot disagree.
 *
 * Everything quoted is required to be verbatim, and the schema caps the length
 * of a quote rather than trusting the instruction. The row is read by somebody
 * who was not on the call; a paraphrase in quotation marks is a sentence a
 * customer never said, permanently attached to their record.
 */

/** The gateway feature key. Spend, audit and usage are attributed to it. */
export const CALL_ANALYSIS_FEATURE = "crm.call-analysis";
export const CALL_ANALYSIS_PROMPT_KEY = "crm.call-analysis";
export const CALL_ANALYSIS_PROMPT_VERSION = 1;

/**
 * The number that lets a cached answer be superseded, and the only thing that
 * can.
 *
 * Bump this — in the same commit — whenever the prompt text, the schema below,
 * or the metric definitions change. The cache promise is "the same transcript
 * is free and reads the same", and it holds per analyser version; without the
 * bump, a prompt change would apply to calls nobody had analysed yet and to no
 * others, so two calls made the same afternoon would be judged by different
 * software with nothing on the row to say so.
 */
export const CALL_ANALYSIS_ANALYZER_VERSION = 1;

/**
 * The cap on how much transcript is judged.
 *
 * Matched to the ingress seam's own body cap (`MAX_BODY_CHARS` in
 * `telephony-to-inbound-event.ts`) rather than chosen independently, so a
 * transcript that survived the seam is never truncated a second time here. A
 * call that does exceed it is analysed from its opening — the objections and
 * the discovery questions are near the front, and the next step is at the end,
 * which is the one thing this loses. `transcript_chars` on the row records what
 * was actually read so a short answer can be explained rather than guessed at.
 */
export const MAX_TRANSCRIPT_CHARS = 100_000;

const quote = z.string().trim().min(1).max(500);

export const callAnalysisJudgementSchema = z.object({
  /**
   * The speaker labels belonging to the selling side, spelled exactly as the
   * transcript spells them.
   *
   * The model's only job that feeds a number. It is checked against the
   * transcript's own labels in `speakerMetrics`, which returns null on a label
   * that is not there — so a hallucinated speaker costs the talk ratio and
   * cannot corrupt it.
   */
  repSpeakers: z.array(z.string().trim().min(1).max(40)).max(8),

  objections: z
    .array(
      z.object({
        quote,
        handling: z.enum(OBJECTION_HANDLINGS),
        /** The rep's reply, verbatim. Null when nobody answered. */
        response: z.string().trim().max(500).nullable(),
      }),
    )
    .max(20),

  competitorMentions: z
    .array(z.object({ name: z.string().trim().min(1).max(120), quote }))
    .max(20),

  /**
   * Whether a specific next action was agreed by both sides.
   *
   * "I'll think about it" is not a commitment and "we'll be in touch" is not
   * one either; the prompt says so explicitly, because a next-step rate that
   * counts politeness is a metric that reports every call as a success.
   */
  nextStepCommitted: z.boolean(),
  nextStep: z.string().trim().max(500).nullable(),
});

export type CallAnalysisJudgement = z.infer<typeof callAnalysisJudgementSchema>;

export const CALL_ANALYSIS_SYSTEM_PROMPT = [
  "You analyse one completed sales call from its transcript.",
  "",
  "You report only what the transcript contains. If something is not in it, leave the field empty",
  "rather than inferring it from how the call sounded; an invented objection becomes a permanent",
  "note on a customer's record.",
  "",
  "Quotes must be copied from the transcript word for word. Never paraphrase inside a quote.",
  "",
  "repSpeakers: the labels used by the selling side (the rep, and any colleague of theirs on the",
  "call). Copy the labels exactly as the transcript writes them. If you cannot tell which side is",
  "selling, return an empty list rather than guessing.",
  "",
  "objections: things the customer raised as a reason not to proceed - price, timing, an incumbent,",
  "authority, risk. Not questions, and not curiosity. For each, say how the rep dealt with it:",
  "'answered' when they gave a substantive response, 'acknowledged' when they recognised it without",
  "resolving it, 'deflected' when they changed the subject, 'unaddressed' when nobody replied.",
  "'response' is the rep's reply verbatim, or null when the handling was 'unaddressed'.",
  "",
  "competitorMentions: named rival products or vendors. Not generic phrases like 'our current tool'",
  "and not your own product.",
  "",
  "nextStepCommitted: true only when a specific action was agreed by both sides - a scheduled",
  "meeting, a document to be sent by a named time, an introduction to a named person. Vague",
  "goodwill ('I'll think about it', 'we'll be in touch', 'let's stay in contact') is false.",
  "nextStep is that action in one sentence, or null when nothing was committed.",
].join("\n");

export interface CallAnalysisPromptContext {
  readonly transcript: string;
  /** Null when the transcript is not speaker-attributed. */
  readonly diarised: DiarisedTranscript | null;
  readonly occurredAt: Date;
}

/**
 * The user half of the prompt.
 *
 * The speaker list is handed over explicitly when there is one, so that
 * `repSpeakers` is a choice from a closed set rather than free text. That does
 * not make a wrong answer impossible — `speakerMetrics` still checks — but it
 * removes the commonest failure, which is the model returning "Salesperson" for
 * a transcript that says "Speaker 1".
 */
export function buildCallAnalysisPrompt(context: CallAnalysisPromptContext): string {
  const speakerLine = context.diarised
    ? `Speaker labels in this transcript: ${context.diarised.speakers.join(", ")}. ` +
      "repSpeakers must be chosen from exactly these."
    : "This transcript has no speaker labels. Return an empty repSpeakers list.";

  return [
    `Call date: ${context.occurredAt.toISOString().slice(0, 10)}`,
    speakerLine,
    "",
    "Transcript:",
    context.transcript,
  ].join("\n");
}
