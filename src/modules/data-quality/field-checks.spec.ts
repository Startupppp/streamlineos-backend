import { assessReachability, type ReachabilitySubject } from "./field-checks";

const subject = (patch: Partial<ReachabilitySubject> = {}): ReachabilitySubject => ({
  email: "buyer@example.com",
  phone: "+44 20 7946 0958",
  whatsappPhone: null,
  ...patch,
});

describe("assessReachability", () => {
  it("says nothing about a party it can reach", () => {
    expect(assessReachability(subject())).toEqual([]);
  });

  it("accepts a party reachable by only one channel", () => {
    expect(assessReachability(subject({ email: null }))).toEqual([]);
    expect(assessReachability(subject({ phone: null }))).toEqual([]);
  });

  /**
   * A record with nothing to check cannot also have a malformed anything.
   * Reporting both would count the same party twice in the health number.
   */
  it("reports no-channel alone, and stops there", () => {
    const problems = assessReachability({ email: null, phone: null, whatsappPhone: null });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      kind: "reachability.no-channel",
      severity: "high",
    });
  });

  it("treats blank strings as absent, not as malformed", () => {
    const problems = assessReachability({ email: "  ", phone: "", whatsappPhone: null });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("reachability.no-channel");
  });

  it("counts a WhatsApp number as a channel", () => {
    const problems = assessReachability({
      email: null,
      phone: null,
      whatsappPhone: "+44 7700 900123",
    });
    expect(problems).toEqual([]);
  });

  describe("e-mail", () => {
    it.each([
      ["no @", "buyer.example.com", "at-count"],
      ["two @", "buyer@@example.com", "at-count"],
      ["no domain suffix", "buyer@example", "no-domain-dot"],
      ["a trailing dot", "buyer@example.", "domain-dot-edge"],
      ["embedded whitespace", "buyer @example.com", "whitespace"],
    ])("flags an address with %s", (_label, email, shape) => {
      const problems = assessReachability(subject({ email }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({
        kind: "reachability.malformed-email",
        groupKey: `reachability:malformed-email:${shape}`,
      });
    });

    it("groups every address that is wrong the same way together", () => {
      const keys = new Set(
        ["a@example", "b@localhost", "c@intranet"].map(
          (email) => assessReachability(subject({ email }))[0]?.groupKey,
        ),
      );
      expect(keys.size).toBe(1);
    });
  });

  describe("phone", () => {
    /**
     * The systematic-error case this whole design is for: an export that dropped
     * its country code leaves hundreds of numbers short by the same amount, and
     * the digit count in the group key is what turns that into one decision
     * rather than four hundred investigations.
     */
    it("puts the digit count in the group key so one import error is one group", () => {
      const keys = new Set(
        ["123456", "654321", "111 222"].map(
          (phone) => assessReachability(subject({ phone }))[0]?.groupKey,
        ),
      );
      expect(keys).toEqual(new Set(["reachability:malformed-phone:6-digits"]));
    });

    it("flags a number carrying letters", () => {
      expect(assessReachability(subject({ phone: "0800-FLOWERS" }))[0]).toMatchObject({
        groupKey: "reachability:malformed-phone:letters",
      });
    });

    it("flags a number longer than any dialable one", () => {
      expect(assessReachability(subject({ phone: "1234567890123456" }))[0]).toMatchObject({
        groupKey: "reachability:malformed-phone:over-e164",
      });
    });

    /**
     * A queue that cries wolf gets ignored, which costs more than the findings it
     * misses — so anything plausibly dialable is left alone.
     */
    it("leaves plausible numbers alone whatever their punctuation", () => {
      for (const phone of ["+1 (415) 555-0132", "020 7946 0958", "0044.20.7946.0958"])
        expect(assessReachability(subject({ phone }))).toEqual([]);
    });
  });

  it("reports both channels when both are wrong", () => {
    const problems = assessReachability({
      email: "broken",
      phone: "12",
      whatsappPhone: null,
    });
    expect(problems.map((problem) => problem.kind)).toEqual([
      "reachability.malformed-email",
      "reachability.malformed-phone",
    ]);
  });

  it("gives every problem one severity per group key", () => {
    const seen = new Map<string, string>();
    const cases: ReachabilitySubject[] = [
      { email: null, phone: null, whatsappPhone: null },
      subject({ email: "broken" }),
      subject({ phone: "12" }),
      subject({ email: "a@b", phone: "0800-FLOWERS" }),
    ];

    for (const input of cases)
      for (const problem of assessReachability(input)) {
        const previous = seen.get(problem.groupKey);
        if (previous !== undefined) expect(previous).toBe(problem.severity);
        seen.set(problem.groupKey, problem.severity);
      }

    expect(seen.size).toBeGreaterThan(0);
  });
});
