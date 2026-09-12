import { createHash } from "node:crypto";

/**
 * The cache key, and the one decision that decides whether the cache works.
 *
 * A hash over the raw bytes is too strict: the same transcript arriving from a
 * carrier once with CRLF line endings and once with LF is one call and two
 * cache misses, so the promise "re-analysing a call is free" quietly stops
 * holding for exactly the deliveries most likely to repeat. A hash over
 * aggressively normalised text is too loose in the other direction, and a
 * collision here is not a wasted model call — it is one customer's call
 * analysis returned on another customer's record.
 *
 * So the normalisation below removes only differences that carry no meaning,
 * and each omission is deliberate:
 *
 * Case is NOT folded. The analysis quotes the transcript back verbatim, so two
 * transcripts differing in case are two different sets of quotes, and serving
 * one for the other would put words a customer did not use inside quotation
 * marks on their record.
 *
 * Punctuation is NOT stripped. "We can do that" and "We can do that?" are
 * opposite calls, and the question count is computed from exactly those marks.
 *
 * Interior whitespace within a line is NOT collapsed. It costs a cache miss on
 * a re-indented transcript, which is rare; collapsing it would merge
 * speaker-label alignment differences that a diarisation parser reads.
 */

/** Windows and old-Mac line endings, which no transcript means anything by. */
const LINE_ENDINGS = /\r\n?/g;
/** Three or more blank lines, which is a formatter's decision, not a speaker's. */
const BLANK_RUNS = /\n{3,}/g;
/** Trailing spaces and tabs, which survive every copy-paste and mean nothing. */
const TRAILING_SPACE = /[ \t]+$/gm;

/**
 * The exact text that gets hashed — and, deliberately, the exact text that gets
 * sent to the model.
 *
 * Those two being the same string is load-bearing rather than tidy. If the
 * prompt were built from the raw body while the key came from the normalised
 * one, the cached answer would correspond to a prompt nobody could reconstruct
 * from the key, and a report of a wrong analysis could not be reproduced.
 */
export function normaliseTranscript(raw: string): string {
  return raw
    .replace(LINE_ENDINGS, "\n")
    .replace(TRAILING_SPACE, "")
    .replace(BLANK_RUNS, "\n\n")
    .trim();
}

/**
 * SHA-256, lowercase hex, of the normalised transcript.
 *
 * SHA-256 rather than a cheap non-cryptographic hash because the consequence of
 * a collision is disclosure, not a slow query: two tenants' rows are separated
 * by the organisation predicate, but two calls *within* one tenant colliding
 * would show one customer's objections on another's timeline. A 64-bit hash
 * makes that a birthday problem at a few hundred million calls; this one does
 * not have the problem at all.
 *
 * Not truncated to save a column. The full digest is 64 characters and the
 * migration's CHECK pins that length, so a truncated value cannot be written by
 * a later caller that decided storage mattered more.
 */
export function transcriptHash(raw: string): string {
  return createHash("sha256").update(normaliseTranscript(raw), "utf8").digest("hex");
}
