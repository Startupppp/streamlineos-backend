import {
  summarizeTicketResponseSchema,
  summarizeCommentsResponseSchema,
  ticketHandoffResponseSchema,
} from "./ai-projects-response.schemas";

describe("summarizeTicketResponseSchema accepts the shape TicketSummaryOutputSchema produces", () => {
  it("accepts a shape with blockers so the response contract matches the gateway output", () => {
    const serviceOutput = { summary: "s", keyPoints: ["k1"], blockers: ["b1"] };
    expect(() => summarizeTicketResponseSchema.parse(serviceOutput)).not.toThrow();
  });

  it("preserves blockers in the parsed value so callers never read undefined", () => {
    const parsed = summarizeTicketResponseSchema.parse({
      summary: "s",
      keyPoints: [],
      blockers: ["blocked by design review"],
    });
    expect(parsed.blockers).toEqual(["blocked by design review"]);
  });

  it("accepts an empty blockers array because the gateway produces it when none are found", () => {
    const parsed = summarizeTicketResponseSchema.parse({ summary: "s", keyPoints: [], blockers: [] });
    expect(parsed.blockers).toEqual([]);
  });
});

describe("summarizeCommentsResponseSchema accepts the shape TicketCommentsSummaryOutputSchema produces", () => {
  it("accepts a shape with themes and openQuestions so the response contract matches the gateway output", () => {
    const serviceOutput = { summary: "s", themes: ["auth"], openQuestions: ["why?"] };
    expect(() => summarizeCommentsResponseSchema.parse(serviceOutput)).not.toThrow();
  });

  it("preserves themes in the parsed value so callers never read undefined", () => {
    const parsed = summarizeCommentsResponseSchema.parse({
      summary: "s",
      themes: ["performance"],
      openQuestions: [],
    });
    expect(parsed.themes).toEqual(["performance"]);
  });

  it("preserves openQuestions in the parsed value so callers never read undefined", () => {
    const parsed = summarizeCommentsResponseSchema.parse({
      summary: "s",
      themes: [],
      openQuestions: ["is this fixed?"],
    });
    expect(parsed.openQuestions).toEqual(["is this fixed?"]);
  });
});

describe("ticketHandoffResponseSchema accepts the shape TicketHandoffOutputSchema produces", () => {
  const handoff = {
    currentState: "in review",
    keyDecisions: ["use postgres"],
    nextAction: "merge the PR",
    blockers: [],
    citations: [{ source: "description" as const, excerpt: "excerpt text" }],
  };

  it("accepts a shape with currentState, keyDecisions, nextAction, blockers, citations", () => {
    expect(() => ticketHandoffResponseSchema.parse(handoff)).not.toThrow();
  });

  it("preserves currentState so the handoff summary is readable", () => {
    const parsed = ticketHandoffResponseSchema.parse(handoff);
    expect(parsed.currentState).toBe("in review");
  });

  it("preserves citations with source and excerpt so the FE can display evidence", () => {
    const parsed = ticketHandoffResponseSchema.parse(handoff);
    expect(parsed.citations[0]).toEqual({ source: "description", excerpt: "excerpt text" });
  });

  it("rejects a citations entry with an unknown source so the closed enum is enforced", () => {
    const bad = { ...handoff, citations: [{ source: "unknown", excerpt: "x" }] };
    expect(() => ticketHandoffResponseSchema.parse(bad)).toThrow();
  });
});
