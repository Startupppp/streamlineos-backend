/**
 * Whether there is anything here worth paying a provider for.
 *
 * This replaces a twenty-character floor. The floor was written for mail and it
 * was doing two jobs at once, only one of them on purpose: it stopped the
 * product spending a model call on "ok", and — by accident — it stopped a
 * two-word fragment like "go ahead" from ever reaching a model that might read
 * it as a commitment. Ticket 12's WhatsApp evals found the second job by
 * measuring it, which is the only reason anybody knew it was being done.
 *
 * Once extraction reads a thread rather than a message, a length rule answers
 * the wrong question — a burst of five fragments is four hundred characters and
 * every one of them is still a fragment. So both jobs are restated as judgements
 * about meaning, and both are now deliberate:
 *
 *   1. Did anybody say anything? A message that is only greeting and
 *      acknowledgement carries no decision, however long it is.
 *   2. Can what was said stand on its own? A fragment means something in a
 *      conversation and nothing by itself, so a window that holds one short
 *      fragment and nothing else is refused — and the same fragment arriving
 *      with its neighbours is not.
 *
 * Pure, because this decides whether money is spent and whether a deal can be
 * moved, and both of those should be provable without a database.
 */

/** Why nothing was extracted, in words a decision row can carry. */
export type EligibilityRefusal = "nothing-said" | "fragment-standing-alone";

export type Eligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: EligibilityRefusal };

/**
 * The shortest thing that can be a request on its own.
 *
 * A verb, an article and its object — "send the contract", "resend the quote".
 * Under that you have a reaction rather than a statement: "go ahead", "sounds
 * good", "quick one" all point at something else and mean nothing without it.
 * That is the rule the character count was approximating, said out loud.
 */
const MIN_STANDALONE_WORDS = 3;

/**
 * Words that acknowledge rather than say.
 *
 * A closed, deliberately small list. Every entry is a word that can be a whole
 * message and still leave nothing to extract; a message made only of these is
 * somebody being polite, on any channel. Kept short on purpose — a long list
 * starts deleting content, and the failure mode of this list is expensive in
 * exactly one direction: a word wrongly on it silences a real message, while a
 * word missing from it costs one cheap model call.
 */
const ACKNOWLEDGEMENTS: ReadonlySet<string> = new Set([
  "hi",
  "hello",
  "hey",
  "morning",
  "afternoon",
  "evening",
  "ok",
  "okay",
  "k",
  "kk",
  "sure",
  "yes",
  "yep",
  "yeah",
  "yup",
  "no",
  "nope",
  "thanks",
  "thank",
  "thankyou",
  "ty",
  "cheers",
  "great",
  "good",
  "cool",
  "nice",
  "perfect",
  "lovely",
  "please",
  "pls",
  "plz",
  "np",
  "welcome",
  "bye",
  "regards",
  "best",
  "very",
  "much",
  "so",
  "too",
  "really",
  "just",
]);

/**
 * A message as the words in it.
 *
 * Punctuation and emoji are stripped rather than counted: a thumbs-up is a
 * reply and not a sentence, and "!!!" is not three words. Apostrophes and
 * hyphens survive so "we're" and "sign-off" stay one word each.
 */
function wordsOf(message: string): string[] {
  return message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’-]+/gu, " ")
    .split(" ")
    .map((word) => word.replace(/^[-'’]+|[-'’]+$/g, ""))
    .filter((word) => word.length > 0);
}

/** True when every word in the message is one of the acknowledgements. */
function saysNothing(words: readonly string[]): boolean {
  return words.length === 0 || words.every((word) => ACKNOWLEDGEMENTS.has(word));
}

/**
 * Judges the window, not the message.
 *
 * `messages` is one entry per message in the thread window, oldest first, and
 * the separation matters: "standing alone" is a fact about how many of them
 * carry content, and joining them first would throw that away. A caller with one
 * message passes a list of one, and gets exactly the old behaviour for the cases
 * the old rule was right about.
 */
export function judgeEligibility(
  messages: ReadonlyArray<string | null | undefined>,
): Eligibility {
  const spoken = messages
    .map((message) => wordsOf(message ?? ""))
    .filter((words) => !saysNothing(words));

  if (spoken.length === 0) return { eligible: false, reason: "nothing-said" };

  /**
   * One message, and too little of it to mean anything by itself.
   *
   * This is the safety the character floor was providing without meaning to,
   * provided on purpose and scoped to the case it is actually for. "go ahead"
   * with four messages of context around it is a decision; "go ahead" on its own
   * is a reply to something nobody here can see, and acting on it would be
   * guessing what it replied to.
   */
  const total = spoken.reduce((count, words) => count + words.length, 0);
  if (spoken.length === 1 && total < MIN_STANDALONE_WORDS)
    return { eligible: false, reason: "fragment-standing-alone" };

  return { eligible: true };
}

/** What a decision row says about a refusal, in a sentence a person reads. */
export function refusalSummary(reason: EligibilityRefusal): string {
  return reason === "nothing-said"
    ? "Nothing to work with — the message acknowledged rather than said anything."
    : "Nothing to work with — a fragment with no conversation around it to read it against.";
}
