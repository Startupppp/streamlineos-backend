/**
 * Talk ratio and question rate, counted rather than judged.
 *
 * The split this file encodes: a language model decides *which speaker is ours*
 * — a judgement, because carriers label the two sides "Speaker 1"/"Speaker 2",
 * "Agent"/"Caller", or with people's names — and then arithmetic counts the
 * words. Asking the model for the ratio itself was the obvious alternative and
 * is wrong twice over. A model counting words in a ten-thousand-word transcript
 * is guessing, and worse, it makes the number irreproducible: the same call
 * would report 62% today and 58% next quarter, and a coaching conversation
 * would be built on a figure nobody can check. Everything here is a pure
 * function of the transcript, so the same transcript always yields the same
 * ratio — which is half of the cache's promise, and the half a cache cannot
 * deliver on its own.
 *
 * Everything below refuses rather than estimates. A transcript with no speaker
 * attribution has no talk ratio; that is reported as `null` and rendered as
 * "unknown", never as fifty percent. The failure being prevented is a manager
 * coaching a rep on a number that was invented because the field could not be
 * left empty.
 */

export interface TranscriptTurn {
  /** The speaker label as written, first spelling seen. */
  readonly speaker: string;
  /** Everything that speaker said before the next label. */
  readonly text: string;
}

export interface DiarisedTranscript {
  readonly turns: readonly TranscriptTurn[];
  /** Distinct speakers, in the order they first spoke. */
  readonly speakers: readonly string[];
}

export interface SpeakerMetrics {
  /** The rep's share of the words, in basis points of 10000. */
  readonly talkRatioBps: number;
  readonly repTurnCount: number;
  readonly repQuestionCount: number;
}

/**
 * A leading timestamp, which every transcription tool emits and none of them
 * agrees on. Stripped before the label is read; a turn's position in the list
 * is the only ordering anything here uses.
 */
const TIMESTAMP = /^\s*[[(]?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?[\])]?\s*/;

/**
 * `Label:` at the start of a line.
 *
 * Bounded to four words and forty characters, and to a character class with no
 * sentence punctuation in it, because the real hazard is prose: a line reading
 * "So I told them: we can do that" is not a turn by a speaker called "So I told
 * them". The bound does not make that impossible on its own — `isDiarised`
 * below is what actually decides — but it keeps the damage to lines that look
 * like labels.
 */
const LABELLED_LINE = /^([\p{L}\p{N}][\p{L}\p{N} .'’_()#-]{0,39}?)\s*:\s?(.*)$/u;

/** A token counts as a word only if it contains a letter or a digit. */
const WORDLIKE = /[\p{L}\p{N}]/u;

/**
 * How much of the transcript has to be attributed before it counts as
 * diarised.
 *
 * Not 100%: continuation lines, "[laughter]" and blank-line paragraph breaks
 * are all normal and none of them carries a label. Not 20% either — at that
 * point a prose transcript with a handful of "Note:" lines would qualify, every
 * unlabelled paragraph would silently be credited to whoever spoke last, and
 * the ratio would be a fabrication wearing a real number's clothes.
 */
const MIN_LABELLED_SHARE = 0.6;

/**
 * Below this a ratio is arithmetic on noise. Two turns is a greeting; the
 * number would swing thirty points on one sentence, and a manager would read it
 * as a fact about how the rep talks.
 */
const MIN_TURNS = 4;

/** Case and surrounding space are not a different speaker. */
function speakerKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((token) => WORDLIKE.test(token)).length;
}

/**
 * Questions asked, counted as question marks rather than as sentences.
 *
 * A run of them is one question — "really??" is not two — and a turn can hold
 * several, which is why this is not a per-turn boolean. Counting sentences
 * instead would need a sentence splitter, and a wrong sentence splitter turns a
 * discovery call into a monologue on the report.
 */
function questionCount(text: string): number {
  return text.match(/\?+/g)?.length ?? 0;
}

/**
 * The transcript as turns, or `null` when it does not have any.
 *
 * `null` is the honest answer for a summary-style transcript or a single block
 * of prose, and every caller is required to handle it — which is why it is a
 * null return rather than an empty `DiarisedTranscript` that would let a caller
 * compute 0/0 and print a zero.
 */
export function parseDiarisedTranscript(transcript: string): DiarisedTranscript | null {
  const lines = transcript.split("\n");
  const turns: TranscriptTurn[] = [];
  const firstSpelling = new Map<string, string>();

  let nonEmpty = 0;
  let labelled = 0;
  let firstNonEmptyWasLabelled = false;
  let seenNonEmpty = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(TIMESTAMP, "");
    if (!line.trim()) continue;
    nonEmpty += 1;

    const match = LABELLED_LINE.exec(line);
    if (match) {
      labelled += 1;
      const label = match[1]!.trim();
      const key = speakerKey(label);
      if (!firstSpelling.has(key)) firstSpelling.set(key, label);
      turns.push({ speaker: firstSpelling.get(key)!, text: match[2] ?? "" });
    } else if (turns.length > 0) {
      // A continuation of the turn above. Credited to the speaker who is
      // already talking rather than dropped — dropping it would understate
      // whoever writes in paragraphs, which is the person who talked most.
      const last = turns[turns.length - 1]!;
      turns[turns.length - 1] = { speaker: last.speaker, text: `${last.text}\n${line}` };
    }

    if (!seenNonEmpty) {
      seenNonEmpty = true;
      firstNonEmptyWasLabelled = match !== null;
    }
  }

  const speakers = [...firstSpelling.values()];

  /**
   * Four conditions, and the first one is the one that matters. A real
   * transcript opens with a speaker; prose that happens to contain colons does
   * not, and without this check the metrics would be computed from the first
   * mid-document colon onward.
   */
  if (!firstNonEmptyWasLabelled) return null;
  if (speakers.length < 2) return null;
  if (turns.length < MIN_TURNS) return null;
  if (nonEmpty === 0 || labelled / nonEmpty < MIN_LABELLED_SHARE) return null;

  return { turns, speakers };
}

/**
 * The counts, given who "we" are — or `null` when that question was not
 * answered usably.
 *
 * Three refusals, each of which would otherwise become a plausible wrong
 * number. Naming nobody leaves the denominator without a numerator. Naming a
 * speaker who is not in the transcript means the model hallucinated a label,
 * and treating that as "the rep said nothing" would report a talk ratio of zero
 * for a rep who never stopped talking. Naming *every* speaker means the model
 * failed to find the customer, and 100% would be read as a monologue rather
 * than as the failure it is.
 */
export function speakerMetrics(
  transcript: DiarisedTranscript,
  repSpeakers: readonly string[],
): SpeakerMetrics | null {
  const present = new Set(transcript.speakers.map(speakerKey));
  const rep = new Set(repSpeakers.map(speakerKey).filter((key) => key.length > 0));

  if (rep.size === 0) return null;
  for (const key of rep) if (!present.has(key)) return null;
  if (rep.size >= present.size) return null;

  let repWords = 0;
  let totalWords = 0;
  let repTurnCount = 0;
  let repQuestionCount = 0;

  for (const turn of transcript.turns) {
    const words = wordCount(turn.text);
    totalWords += words;
    if (!rep.has(speakerKey(turn.speaker))) continue;
    repWords += words;
    repTurnCount += 1;
    repQuestionCount += questionCount(turn.text);
  }

  // Labels and no words. Nothing to take a ratio of, and zero would be a claim.
  if (totalWords === 0) return null;

  return {
    talkRatioBps: Math.round((repWords * 10_000) / totalWords),
    repTurnCount,
    repQuestionCount,
  };
}

/**
 * Questions per rep turn, in basis points — derived on read rather than stored.
 *
 * The counts are what the row keeps; see the schema. This is here so that every
 * surface that shows a rate computes it the same way, which is the only reason
 * a derived number belongs in a shared function at all.
 */
export function questionRateBps(
  repQuestionCount: number | null,
  repTurnCount: number | null,
): number | null {
  if (repQuestionCount === null || repTurnCount === null || repTurnCount <= 0) return null;
  return Math.round((repQuestionCount * 10_000) / repTurnCount);
}
