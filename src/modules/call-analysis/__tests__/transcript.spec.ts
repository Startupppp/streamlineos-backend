import {
  capTranscript,
  digestOf,
  MAX_TRANSCRIPT_CHARS,
  readTranscript,
} from "../transcript";

const DIARISED = [
  "Agent: Thanks for calling.",
  "Customer: We're looking at replacing our current system.",
  "Agent: What made you start looking?",
  "Customer: It falls over every month end and support take three days to answer.",
].join("\n");

describe("readTranscript — the two ratios", () => {
  it("counts our share of the words, not our share of the turns", () => {
    const reading = readTranscript(
      ["Agent: one two three four", "Customer: five six"].join("\n"),
    );

    // Four words of six. Turn-counting would have said fifty percent.
    expect(reading.talkRatioBps).toBe(6_667);
  });

  it("reports the share of our turns that asked something", () => {
    const reading = readTranscript(DIARISED);

    // One of the seller's two turns asked a question.
    expect(reading.questionShareBps).toBe(5_000);
  });

  it("finds a question in an unpunctuated transcript", () => {
    // Automatic transcription routinely returns no punctuation. A detector that
    // only looked for "?" would report this rep as having asked nothing at all,
    // which is a coaching signal pointing the wrong way rather than a missing one.
    const reading = readTranscript(
      ["Agent: what made you start looking", "Customer: month end keeps breaking"].join("\n"),
    );

    expect(reading.questionShareBps).toBe(10_000);
  });

  it("does not read a statement about a question as a question", () => {
    const reading = readTranscript(
      [
        "Agent: I know how the migration works and I will send the notes over.",
        "Customer: Great.",
      ].join("\n"),
    );

    expect(reading.questionShareBps).toBe(0);
  });
});

describe("readTranscript — refusing to invent a ratio", () => {
  it("produces no ratios at all when the transcript never says who is speaking", () => {
    const reading = readTranscript(
      "We're looking at replacing our current system. It falls over every month end.",
    );

    expect(reading).toMatchObject({
      diarisation: "unknown",
      talkRatioBps: null,
      questionShareBps: null,
    });
  });

  it("produces no ratios when only one side is labelled", () => {
    /**
     * The case that looks like success. Half a transcript labelled "Agent:" with
     * the customer running on unlabelled would otherwise report every call as a
     * rep who did one hundred percent of the talking.
     */
    const reading = readTranscript(
      [
        "Agent: Thanks for calling, how can I help?",
        "Speaker 2: We're looking at replacing our system.",
      ].join("\n"),
    );

    expect(reading.talkRatioBps).toBeNull();
  });

  it("does not fold an unrecognised speaker's words into the previous speaker", () => {
    const reading = readTranscript(
      [
        "Agent: hello",
        "Speaker 3: I am going to say a great many words here indeed yes",
        "Customer: hi",
      ].join("\n"),
    );

    // One word each side. If the unknown speaker's eleven words had been folded
    // into the seller's turn the ratio would read 12/13.
    expect(reading.talkRatioBps).toBe(5_000);
  });

  it("drops a header written before anybody spoke", () => {
    const reading = readTranscript(
      [
        "Call recorded 4 September 2026, duration 6m 12s",
        "Agent: hello",
        "Customer: hi",
      ].join("\n"),
    );

    expect(reading.talkRatioBps).toBe(5_000);
  });

  it("is not fooled by a colon inside a sentence", () => {
    const reading = readTranscript(
      [
        "Agent: hello",
        "Customer: the thing is: we already have a supplier and they are cheap",
      ].join("\n"),
    );

    expect(reading.turns).toHaveLength(2);
  });
});

describe("digestOf and capTranscript", () => {
  it("gives the same digest to the same text and a different one to changed text", () => {
    expect(digestOf(DIARISED)).toBe(digestOf(DIARISED));
    expect(digestOf(DIARISED)).not.toBe(digestOf(`${DIARISED}\nAgent: one more thing.`));
  });

  it("digests the capped text, so a long transcript matches itself on the next pass", () => {
    /**
     * The bug this exists to prevent: cap after digesting and the stored digest
     * is a hash of text nobody analysed, so it never matches on the next pass
     * and every long call in the organisation is re-analysed forever.
     */
    const long = "Agent: hello. ".repeat(4_000);
    expect(long.length).toBeGreaterThan(MAX_TRANSCRIPT_CHARS);
    expect(digestOf(capTranscript(long))).toBe(digestOf(capTranscript(capTranscript(long))));
  });
});
