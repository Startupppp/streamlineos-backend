import { normaliseTranscript, transcriptHash } from "./transcript-hash";

/**
 * The cache is only as good as the key, so these assert the two properties the
 * key has to have and nothing about the digest's value.
 *
 * The failure the first group prevents: a transcript re-delivered with
 * different line endings misses the cache, pays for a second model call, and
 * returns a *different* answer for the same call — which is the exact thing the
 * ticket exists to make impossible.
 *
 * The failure the second group prevents: normalisation reaching far enough to
 * make two genuinely different calls hash the same, which puts one customer's
 * words on another customer's record.
 */
describe("the transcript hash", () => {
  const TRANSCRIPT = "Rep: Hi there.\nCustomer: We already use Acme.\nRep: What made you pick them?";

  describe("is stable across differences nobody meant", () => {
    it("does not change with line endings", () => {
      expect(transcriptHash(TRANSCRIPT.replace(/\n/g, "\r\n"))).toBe(
        transcriptHash(TRANSCRIPT),
      );
    });

    it("does not change with trailing whitespace on a line", () => {
      expect(transcriptHash(TRANSCRIPT.replace(/\n/g, "   \n"))).toBe(
        transcriptHash(TRANSCRIPT),
      );
    });

    it("does not change with leading or trailing blank lines", () => {
      expect(transcriptHash(`\n\n${TRANSCRIPT}\n\n\n`)).toBe(transcriptHash(TRANSCRIPT));
    });

    it("does not change when a paragraph gap grows", () => {
      const two = "Rep: Hi.\n\nCustomer: Hello.";
      const five = "Rep: Hi.\n\n\n\n\nCustomer: Hello.";
      expect(transcriptHash(five)).toBe(transcriptHash(two));
    });

    it("is the same string the prompt is built from", () => {
      // If these ever diverge, a cached answer stops corresponding to any
      // prompt that can be rebuilt from its key.
      const normalised = normaliseTranscript(`  ${TRANSCRIPT}  `);
      expect(transcriptHash(normalised)).toBe(transcriptHash(TRANSCRIPT));
    });
  });

  describe("changes with every difference that is one", () => {
    it("distinguishes case", () => {
      expect(transcriptHash(TRANSCRIPT.toLowerCase())).not.toBe(transcriptHash(TRANSCRIPT));
    });

    it("distinguishes a question from a statement", () => {
      const statement = TRANSCRIPT.replace("What made you pick them?", "What made you pick them.");
      expect(transcriptHash(statement)).not.toBe(transcriptHash(TRANSCRIPT));
    });

    it("distinguishes who said which line", () => {
      const swapped = "Customer: Hi there.\nRep: We already use Acme.\nRep: What made you pick them?";
      expect(transcriptHash(swapped)).not.toBe(transcriptHash(TRANSCRIPT));
    });

    it("distinguishes a line break from a space", () => {
      expect(transcriptHash("Rep: one two")).not.toBe(transcriptHash("Rep: one\ntwo"));
    });
  });

  it("is 64 lowercase hex characters, which the migration's CHECK pins", () => {
    expect(transcriptHash(TRANSCRIPT)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic across calls in one process", () => {
    expect(transcriptHash(TRANSCRIPT)).toBe(transcriptHash(TRANSCRIPT));
  });
});
