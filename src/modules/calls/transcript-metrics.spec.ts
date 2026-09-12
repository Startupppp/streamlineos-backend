import {
  parseDiarisedTranscript,
  questionRateBps,
  speakerMetrics,
} from "./transcript-metrics";

/**
 * Every assertion here is about a number that would otherwise be invented.
 *
 * The metrics exist to be shown to a sales manager next to a rep's name, so the
 * failure mode is not "slightly wrong" — it is a coaching conversation held on
 * the strength of a figure that came from nowhere. The refusals are therefore
 * on trial at least as hard as the arithmetic.
 */

const DIARISED = [
  "Rep: Thanks for making time. What are you using today?",
  "Customer: We are on Acme. It works fine.",
  "Rep: What made you pick Acme?",
  "Customer: Price, mostly. Yours looks expensive.",
  "Rep: I hear that a lot. Can I show you the total cost side by side?",
  "Customer: Sure, send it over.",
].join("\n");

describe("reading a transcript into turns", () => {
  it("attributes each line to the speaker that labelled it", () => {
    const parsed = parseDiarisedTranscript(DIARISED);
    expect(parsed?.speakers).toEqual(["Rep", "Customer"]);
    expect(parsed?.turns).toHaveLength(6);
    expect(parsed?.turns[1]?.text).toBe("We are on Acme. It works fine.");
  });

  it("treats one speaker's two spellings as one speaker", () => {
    // A carrier that writes "REP:" on one line and "Rep:" on the next must not
    // produce a three-way split that makes every ratio wrong.
    const parsed = parseDiarisedTranscript(DIARISED.replace("Rep: What made", "REP: What made"));
    expect(parsed?.speakers).toEqual(["Rep", "Customer"]);
  });

  it("credits an unlabelled continuation to whoever is already talking", () => {
    // Dropping it would understate the person who writes in paragraphs, which
    // is reliably the person who talked most.
    const parsed = parseDiarisedTranscript(
      `${DIARISED}\nand I will loop in my finance lead.`,
    );
    expect(parsed?.turns).toHaveLength(6);
    expect(parsed?.turns[5]?.speaker).toBe("Customer");
    expect(parsed?.turns[5]?.text).toContain("finance lead");
  });

  it("strips a leading timestamp rather than reading it as a speaker", () => {
    const stamped = DIARISED.split("\n")
      .map((line, index) => `[00:0${index}] ${line}`)
      .join("\n");
    expect(parseDiarisedTranscript(stamped)?.speakers).toEqual(["Rep", "Customer"]);
  });

  describe("refuses a transcript it cannot attribute", () => {
    it("refuses prose, however many colons it contains", () => {
      const prose =
        "The customer called about pricing: they are on Acme today.\n" +
        "One concern: the migration. Another: the contract term.\n" +
        "We agreed to follow up: a proposal by Friday.";
      // Without the "first line must be labelled" rule this parses as four
      // speakers and yields a confident, fabricated ratio.
      expect(parseDiarisedTranscript(prose)).toBeNull();
    });

    it("refuses a monologue, because a one-sided ratio is not a ratio", () => {
      const single = ["Rep: One.", "Rep: Two.", "Rep: Three.", "Rep: Four."].join("\n");
      expect(parseDiarisedTranscript(single)).toBeNull();
    });

    it("refuses a call too short for the number to mean anything", () => {
      const greeting = ["Rep: Hello?", "Customer: Wrong number.", "Rep: No problem."].join("\n");
      expect(parseDiarisedTranscript(greeting)).toBeNull();
    });

    it("refuses when most of the text carries no label at all", () => {
      const mostlyProse = [
        "Rep: Hello.",
        "Customer: Hi.",
        "Rep: Right.",
        "Customer: Yes.",
        ...Array.from({ length: 20 }, (_, i) => `unattributed paragraph ${i}`),
      ].join("\n");
      expect(parseDiarisedTranscript(mostlyProse)).toBeNull();
    });
  });
});

describe("counting what each side did", () => {
  const parsed = parseDiarisedTranscript(DIARISED)!;

  it("counts words, not characters or lines", () => {
    // 29 of the 45 words are the rep's. Pinned exactly, because the assertion
    // that matters is the second one — a re-wrapped transcript is the same
    // call, and a metric that moved with line breaks would rank reps by how
    // their transcription tool happened to fold long sentences.
    expect(speakerMetrics(parsed, ["Rep"])?.talkRatioBps).toBe(6444);

    const rewrapped = parseDiarisedTranscript(DIARISED.replace(". Can I", ".\nCan I"))!;
    expect(speakerMetrics(rewrapped, ["Rep"])?.talkRatioBps).toBe(6444);
  });

  it("reports the ratio in basis points of the whole call", () => {
    const even = parseDiarisedTranscript(
      ["Rep: one two", "Customer: three four", "Rep: five six", "Customer: seven eight"].join("\n"),
    )!;
    expect(speakerMetrics(even, ["Rep"])?.talkRatioBps).toBe(5000);
  });

  it("counts a run of question marks as one question", () => {
    const parsedRun = parseDiarisedTranscript(
      ["Rep: really??", "Customer: yes", "Rep: why? how?", "Customer: because"].join("\n"),
    )!;
    const metrics = speakerMetrics(parsedRun, ["Rep"]);
    expect(metrics?.repQuestionCount).toBe(3);
    expect(metrics?.repTurnCount).toBe(2);
  });

  it("counts only the rep's questions, never the customer's", () => {
    expect(speakerMetrics(parsed, ["Rep"])?.repQuestionCount).toBe(3);
    expect(speakerMetrics(parsed, ["Customer"])?.repQuestionCount).toBe(0);
  });

  it("accepts more than one label for our side", () => {
    const threeWay = parseDiarisedTranscript(
      [
        "Rep: one two",
        "Customer: three four",
        "Sales Engineer: five six",
        "Customer: seven eight",
      ].join("\n"),
    )!;
    expect(speakerMetrics(threeWay, ["Rep", "Sales Engineer"])?.talkRatioBps).toBe(5000);
  });

  describe("refuses rather than producing a plausible number", () => {
    it("refuses when nobody is named as ours", () => {
      expect(speakerMetrics(parsed, [])).toBeNull();
    });

    it("refuses a speaker who is not in the transcript", () => {
      // A hallucinated label would otherwise count zero rep words and report a
      // talk ratio of 0 for a rep who never stopped talking.
      expect(speakerMetrics(parsed, ["Salesperson"])).toBeNull();
    });

    it("refuses when every speaker is ours", () => {
      // 100% is not a monologue here, it is a failure to find the customer.
      expect(speakerMetrics(parsed, ["Rep", "Customer"])).toBeNull();
    });
  });
});

describe("the question rate", () => {
  it("is questions per rep turn in basis points", () => {
    expect(questionRateBps(3, 4)).toBe(7500);
  });

  it("is unknown rather than zero when there were no turns to divide by", () => {
    expect(questionRateBps(0, 0)).toBeNull();
    expect(questionRateBps(null, 4)).toBeNull();
  });
});
