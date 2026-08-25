import { judgeEligibility, refusalSummary } from "./eligibility";

/**
 * The rule that replaced a twenty-character floor.
 *
 * Ticket 12 measured what that floor was really doing: it stopped the product
 * paying for "ok", and it stopped "go ahead" advancing a deal — and only the
 * first of those was on purpose. These are the cases that pin both jobs to a
 * judgement about meaning instead, now that a fragment can be read with the
 * messages around it.
 */
describe("judgeEligibility", () => {
  describe("nothing was said", () => {
    it("refuses a message that only acknowledges", () => {
      expect(judgeEligibility(["ok"])).toEqual({ eligible: false, reason: "nothing-said" });
      expect(judgeEligibility(["thanks!"])).toEqual({ eligible: false, reason: "nothing-said" });
      expect(judgeEligibility(["morning"])).toEqual({ eligible: false, reason: "nothing-said" });
      expect(judgeEligibility(["ok thanks, cheers"])).toEqual({
        eligible: false,
        reason: "nothing-said",
      });
    });

    /**
     * A reply that is a picture of a thumb is still a reply. It is not a
     * sentence, and the old rule caught it only because emoji are short.
     */
    it("refuses emoji and punctuation, which carry no words at all", () => {
      expect(judgeEligibility(["👍"])).toEqual({ eligible: false, reason: "nothing-said" });
      expect(judgeEligibility(["!!!"])).toEqual({ eligible: false, reason: "nothing-said" });
      expect(judgeEligibility([""])).toEqual({ eligible: false, reason: "nothing-said" });
      expect(judgeEligibility([])).toEqual({ eligible: false, reason: "nothing-said" });
      expect(judgeEligibility([null, undefined, "   "])).toEqual({
        eligible: false,
        reason: "nothing-said",
      });
    });

    /**
     * The one the length rule could not express. A polite message can be long
     * and still say nothing, and paying a provider to discover that is the cost
     * the short-circuit exists to avoid.
     */
    it("refuses a long message that is all acknowledgement", () => {
      const polite = "thanks very much, really great, perfect, cheers";
      expect(polite.length).toBeGreaterThan(20);
      expect(judgeEligibility([polite])).toEqual({ eligible: false, reason: "nothing-said" });
    });
  });

  describe("a fragment standing on its own", () => {
    /**
     * The safety the floor was providing by accident, provided on purpose.
     *
     * "go ahead" is one of two readings — permission to proceed, or a reply to
     * something nobody here can see — and acting on it means guessing which.
     */
    it("refuses a two-word fragment with no conversation around it", () => {
      expect(judgeEligibility(["go ahead"])).toEqual({
        eligible: false,
        reason: "fragment-standing-alone",
      });
      expect(judgeEligibility(["quick one"])).toEqual({
        eligible: false,
        reason: "fragment-standing-alone",
      });
    });

    /**
     * And the whole point of the ticket: the same fragment, read with its
     * neighbours, is a decision rather than a guess.
     */
    it("admits the same fragment once it has neighbours", () => {
      expect(
        judgeEligibility([
          "we got sign off on the budget yesterday",
          "so we're good to go ahead",
          "go ahead",
        ]),
      ).toEqual({ eligible: true });
    });

    /**
     * A neighbour that says nothing is not a neighbour for this purpose — "ok"
     * beside "go ahead" leaves the fragment exactly as alone as it was.
     */
    it("does not count an acknowledgement as the conversation around it", () => {
      expect(judgeEligibility(["morning", "ok", "go ahead"])).toEqual({
        eligible: false,
        reason: "fragment-standing-alone",
      });
    });

    /** A verb, an article and its object is the shortest standalone request. */
    it("admits three words, which is where a request starts", () => {
      expect(judgeEligibility(["send the contract"])).toEqual({ eligible: true });
      expect(judgeEligibility(["how much for 250 seats?"])).toEqual({ eligible: true });
    });
  });

  /**
   * The behaviour the old rule got right, unchanged — because a replacement that
   * quietly changed the answer for ordinary messages would be a different
   * ticket's worth of risk.
   */
  it("admits an ordinary message", () => {
    expect(judgeEligibility(["Can you send the quote for the Q3 renewal?"])).toEqual({
      eligible: true,
    });
    expect(
      judgeEligibility(["Agent: thanks for calling. Caller: I want to renew the annual plan."]),
    ).toEqual({ eligible: true });
  });

  it("says which refusal it was, in words a decision row can carry", () => {
    expect(refusalSummary("nothing-said")).toContain("acknowledged");
    expect(refusalSummary("fragment-standing-alone")).toContain("fragment");
  });
});
