import { createHash } from "node:crypto";

/**
 * Reading a transcript for the things arithmetic can answer.
 *
 * Talk ratio and question rate are counting problems. Sending them to a model
 * would be paying the most expensive component in the product to do long
 * division, and — worse — would make two runs over the same transcript disagree
 * about how many words a rep said. So the two headline numbers on ticket 01 are
 * computed here, deterministically, and the model is left the two questions that
 * actually need judgement: what was pushed back on, and whether anybody
 * committed to a next step.
 *
 * The refusal below is the important part of this file. A talk ratio is a claim
 * about one *side* of a conversation, so it cannot be computed from a transcript
 * that does not say who was speaking. Producing one anyway would give a rep a
 * plausible-looking number to be coached against that was assembled from
 * whichever speaker the parser happened to see first.
 */

/**
 * Bumped whenever anything in this module changes what an analysis says.
 *
 * Stored on every row beside the transcript digest, and half of the re-analysis
 * key. Hashing only the source text would pin each organisation to whichever
 * analyser first ran over its calls, so a corrected prompt could never reach the
 * calls it was written for.
 */
export const ANALYSER_VERSION = 1;

/** Whether the transcript said who was speaking. */
export type DiarisationBasis = "labelled" | "unknown";

export interface TranscriptTurn {
  readonly side: "us" | "them";
  readonly text: string;
}

export interface TranscriptReading {
  readonly diarisation: DiarisationBasis;
  readonly turns: readonly TranscriptTurn[];
  /** Our share of the words spoken, in basis points. Null when undiarised. */
  readonly talkRatioBps: number | null;
  /** Share of our turns that asked something, in basis points. Null likewise. */
  readonly questionShareBps: number | null;
}

const BPS = 10_000;

/**
 * The labels carriers and transcription services actually emit for each side.
 *
 * Matched on the whole label rather than by substring, because "sales" is one of
 * ours and "sales enquiry" is a caller describing why they rang.
 */
const OUR_LABELS: readonly string[] = [
  "agent",
  "rep",
  "representative",
  "sales",
  "salesperson",
  "account executive",
  "ae",
  "advisor",
  "adviser",
  "consultant",
  "operator",
  "host",
  "us",
];

const THEIR_LABELS: readonly string[] = [
  "customer",
  "client",
  "caller",
  "prospect",
  "contact",
  "buyer",
  "guest",
  "them",
];

/**
 * A speaker label at the head of a line.
 *
 * Capped at forty characters so a sentence containing a colon — "the thing is:
 * we already have a supplier" — is not read as a speaker called "the thing is".
 */
const SPEAKER_LINE = /^[\s>-]*([A-Za-z][A-Za-z0-9 .'_-]{0,39}?)\s*:\s*(.*)$/;

/**
 * What makes a sentence a question when the transcription has no punctuation.
 *
 * Automatic transcription frequently returns unpunctuated text, and a question
 * detector that only looks for `?` reports every such call as a rep who asked
 * nothing — which is a coaching signal pointing the wrong way, not a missing
 * one. Anchored to the start of a sentence: "I know how it works" is not a
 * question and "how does it work" is.
 */
const INTERROGATIVE_OPENING =
  /^(?:what|how|why|when|where|who|which|whose|do|does|did|can|could|would|will|should|are|is|was|were|have|has|had|may|might|tell me)\b/;

/**
 * How much of a transcript is read.
 *
 * A call transcript is the longest text the CRM stores — the ingress seam caps a
 * body at a hundred thousand characters, and an hour-long call reaches that. The
 * cap is applied once, at the point the body is read, and everything downstream
 * uses the capped text: the digest, the model call and the word counts. Capping
 * anywhere later would make the digest a hash of text nobody analysed, so an
 * unchanged transcript would never match its own stored digest and every call in
 * the organisation would be re-analysed on every pass — which is the exact bill
 * this module exists to avoid.
 */
export const MAX_TRANSCRIPT_CHARS = 24_000;

export function capTranscript(body: string): string {
  return body.length > MAX_TRANSCRIPT_CHARS ? body.slice(0, MAX_TRANSCRIPT_CHARS) : body;
}

/** SHA-256 of exactly the text that was read. The whole of the caching rule. */
export function digestOf(sourceText: string): string {
  return createHash("sha256").update(sourceText, "utf8").digest("hex");
}

/**
 * One transcript, as turns and as two ratios.
 *
 * Diarisation succeeds only when *both* sides appear under a recognised label.
 * One-sided labelling is the case that looks like success and is not: a
 * transcript where only "Agent:" is marked and the customer's speech runs on
 * unlabelled would otherwise report a talk ratio of one hundred percent for
 * every call.
 */
export function readTranscript(sourceText: string): TranscriptReading {
  const turns = parseTurns(sourceText);

  const ourWords = turns
    .filter((turn) => turn.side === "us")
    .reduce((total, turn) => total + wordCount(turn.text), 0);
  const theirWords = turns
    .filter((turn) => turn.side === "them")
    .reduce((total, turn) => total + wordCount(turn.text), 0);

  const bothSidesSpoke = ourWords > 0 && theirWords > 0;
  if (!bothSidesSpoke)
    return { diarisation: "unknown", turns: [], talkRatioBps: null, questionShareBps: null };

  const ourTurns = turns.filter((turn) => turn.side === "us");
  const asking = ourTurns.filter((turn) => asksSomething(turn.text)).length;

  return {
    diarisation: "labelled",
    turns,
    talkRatioBps: Math.round((ourWords / (ourWords + theirWords)) * BPS),
    questionShareBps: Math.round((asking / ourTurns.length) * BPS),
  };
}

/**
 * The lines of a transcript as turns, dropping everything unattributable.
 *
 * A line with no label continues the turn above it, which is how a paragraph
 * that wrapped is kept whole. A line before any label at all is dropped: it is
 * usually a header the transcription service wrote — a date, a duration, a
 * disclaimer — and attributing it to the first speaker would put our own
 * vendor's boilerplate into somebody's talk ratio.
 */
function parseTurns(sourceText: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: { side: "us" | "them"; parts: string[] } | null = null;

  for (const line of sourceText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = SPEAKER_LINE.exec(trimmed);
    const side = match ? sideOfLabel(match[1] ?? "") : null;

    if (side) {
      if (current) turns.push({ side: current.side, text: current.parts.join(" ") });
      current = { side, parts: [(match?.[2] ?? "").trim()] };
      continue;
    }

    /**
     * A labelled line whose label is *not* one we recognise ends the turn above
     * rather than extending it. "Speaker 2:" is somebody else talking, and
     * folding their words into the previous speaker's turn is the one error that
     * corrupts the ratio in the direction nobody would notice.
     */
    if (match && current) {
      turns.push({ side: current.side, text: current.parts.join(" ") });
      current = null;
      continue;
    }

    if (current) current.parts.push(trimmed);
  }

  if (current) turns.push({ side: current.side, text: current.parts.join(" ") });
  return turns.filter((turn) => turn.text.length > 0);
}

function sideOfLabel(label: string): "us" | "them" | null {
  const normalised = label.trim().toLowerCase().replace(/\s+/g, " ");
  if (OUR_LABELS.includes(normalised)) return "us";
  if (THEIR_LABELS.includes(normalised)) return "them";
  return null;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Whether any sentence in a turn is a question. */
export function asksSomething(text: string): boolean {
  return text
    .split(/(?<=[.?!])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .some(
      (sentence) =>
        sentence.endsWith("?") || INTERROGATIVE_OPENING.test(sentence.toLowerCase()),
    );
}
