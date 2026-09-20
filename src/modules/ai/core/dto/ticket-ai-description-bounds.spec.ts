import {
  draftTicketBodySchema,
  improveDescriptionBodySchema,
  DESCRIPTION_MAX,
} from "./ticket-ai.schemas";

describe("ticket AI description bounds", () => {
  it("accepts an improve-description draft longer than the old 5000-character ceiling", () => {
    const draft = "a".repeat(5001);
    expect(improveDescriptionBodySchema.safeParse({ draft }).success).toBe(true);
  });

  it("accepts a draft-ticket description longer than the old 5000-character ceiling", () => {
    const description = "a".repeat(5001);
    expect(draftTicketBodySchema.safeParse({ description }).success).toBe(true);
  });

  it("still rejects an improve-description draft past the DoS ceiling", () => {
    const draft = "a".repeat(DESCRIPTION_MAX + 1);
    expect(improveDescriptionBodySchema.safeParse({ draft }).success).toBe(false);
  });

  it("still rejects a draft-ticket description past the DoS ceiling", () => {
    const description = "a".repeat(DESCRIPTION_MAX + 1);
    expect(draftTicketBodySchema.safeParse({ description }).success).toBe(false);
  });
});
