import { buildCallJudgementPrompt, type CallJudgement, type ObjectionTheme } from "../call-judgement.schemas";
import { readTranscript, type TranscriptReading, type TranscriptTurn } from "../transcript";

/**
 * A deterministic stand-in with the analyser's contract, for the eval gate.
 *
 * Every eval suite in this repository is offline by convention — see
 * `evals/channel-extraction.ts`, which explains the trade at length — so what is
 * scored is a rule set rather than a model. Two things make that worth doing
 * here. The path is the real one: the real transcript reader produces the turns,
 * and the real prompt builder produces the string the fence gate inspects, so
 * the two properties that are actually structural (an undiarised call has no
 * talk ratio; an untrusted transcript cannot close its own fence) are measured
 * on the code that ships rather than on a copy of it.
 *
 * And the rules are written to be *wrong* in the ways a careless analyser would
 * be wrong — it will report a commitment from any "I'll send…", including one
 * inside a hostile payload — so each gate below is testing something rather than
 * agreeing with itself.
 */

export interface StandInAnalysis {
  readonly judgement: CallJudgement;
  readonly reading: TranscriptReading;
  /** Exactly what a model would have been sent, so a suite can inspect the fence. */
  readonly prompt: string;
}

/** Phrases that mark a push-back, by what it is about. */
const OBJECTION_PHRASES: readonly (readonly [ObjectionTheme, readonly string[]])[] = [
  ["price", ["too expensive", "out of our budget", "cheaper", "the price is", "the cost is"]],
  ["timing", ["not the right time", "next quarter", "next year", "revisit this in"]],
  ["authority", ["check with", "sign off", "my boss", "the board", "procurement"]],
  ["incumbent", ["we already use", "we're happy with", "current supplier", "also talking to"]],
  ["trust", ["not convinced", "burned before", "how do we know", "i'm worried"]],
  ["fit", ["doesn't do", "does not do", "no integration", "we'd need it to"]],
];

/**
 * A seller's turn that answered nothing.
 *
 * Changing the subject and saying four words are the two shapes of not
 * answering, and they are deliberately not the same as silence: `deflected` is a
 * habit somebody can be coached out of, and `unanswered` is usually a rep who
 * did not hear it.
 */
const DEFLECTION = /^(anyway|moving on|let me show you|as i was saying|let's park)/;

/**
 * A commitment: somebody naming an action they will take.
 *
 * The verb list is closed on purpose. "I'll think about it" and "let's stay in
 * touch" contain no verb from it and therefore produce no next step, which is
 * the distinction the whole field exists for — a pipeline review that counts
 * vague endings reports a healthy pipeline made of calls that quietly stopped.
 */
const COMMITMENT =
  /\b(?:i'?ll|i will|we'?ll|we will)\s+(?:[a-z']+\s+){0,3}(?:send|share|email|set up|book|schedule|put together|get)\b/;

export function analyseWithStandIn(transcript: string): StandInAnalysis {
  const reading = readTranscript(transcript);

  return {
    reading,
    prompt: buildCallJudgementPrompt(transcript),
    judgement: {
      objections: objectionsIn(reading.turns),
      nextStepCommitted: COMMITMENT.test(transcript.toLowerCase()),
      nextStepQuote: null,
    },
  };
}

function objectionsIn(turns: readonly TranscriptTurn[]): CallJudgement["objections"] {
  const objections: CallJudgement["objections"] = [];

  turns.forEach((turn, index) => {
    if (turn.side !== "them") return;
    const lower = turn.text.toLowerCase();

    for (const [theme, phrases] of OBJECTION_PHRASES) {
      if (!phrases.some((phrase) => lower.includes(phrase))) continue;
      objections.push({ theme, quote: turn.text.slice(0, 400), handling: handlingAfter(turns, index) });
      // One theme per turn: a sentence mentioning budget and procurement is one
      // push-back, and counting it twice inflates every rate downstream.
      return;
    }
  });

  return objections;
}

function handlingAfter(turns: readonly TranscriptTurn[], raisedAt: number): "addressed" | "deflected" | "unanswered" {
  const reply = turns.slice(raisedAt + 1).find((turn) => turn.side === "us");
  if (!reply) return "unanswered";

  const lower = reply.text.trim().toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean).length;
  return DEFLECTION.test(lower) || words < 5 ? "deflected" : "addressed";
}
