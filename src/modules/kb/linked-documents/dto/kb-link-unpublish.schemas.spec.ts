import { unpublishLinkSchema, UNPUBLISH_REASON_MAX_LENGTH } from "./kb-link-publish.schemas";

describe("unpublishLinkSchema", () => {
  it("accepts no reason at all, so a caller that sends nothing still withdraws an entry", () => {
    expect(unpublishLinkSchema.parse({})).toEqual({});
  });

  it("reads a request with no body at all (a DELETE sends none) as no reason", () => {
    expect(unpublishLinkSchema.parse(undefined)).toEqual({});
  });

  it("accepts a reason and keeps it, trimmed", () => {
    expect(unpublishLinkSchema.parse({ reason: "  Superseded by the 2026 handbook  " })).toEqual({ reason: "Superseded by the 2026 handbook" });
  });

  it.each(["", "   ", "\n\t"])("refuses a reason with nothing in it (%j), rather than storing a blank", (reason) => {
    expect(unpublishLinkSchema.safeParse({ reason }).success).toBe(false);
  });

  it("refuses a reason longer than it will store, and accepts one exactly at the limit", () => {
    expect(unpublishLinkSchema.safeParse({ reason: "x".repeat(UNPUBLISH_REASON_MAX_LENGTH + 1) }).success).toBe(false);
    expect(unpublishLinkSchema.safeParse({ reason: "x".repeat(UNPUBLISH_REASON_MAX_LENGTH) }).success).toBe(true);
  });

  it("refuses a key it does not know, so nobody can smuggle a status or an actor through it", () => {
    expect(unpublishLinkSchema.safeParse({ reason: "ok", status: "active" }).success).toBe(false);
    expect(unpublishLinkSchema.safeParse({ reason: "ok", userId: "someone" }).success).toBe(false);
  });

  it("refuses a reason that is not text", () => {
    expect(unpublishLinkSchema.safeParse({ reason: 7 }).success).toBe(false);
    expect(unpublishLinkSchema.safeParse({ reason: null }).success).toBe(false);
  });
});
