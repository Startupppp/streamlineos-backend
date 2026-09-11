import {
  listDueReviewsQuerySchema,
  listReviewsQuerySchema,
} from "./dto/kb-page-reviews.schemas";

describe("listReviewsQuerySchema", () => {
  it("accepts valid status and type values", () => {
    expect(() =>
      listReviewsQuerySchema.parse({ status: "pending", type: "approval" }),
    ).not.toThrow();
  });

  it("accepts all valid status values", () => {
    for (const s of ["pending", "approved", "rejected", "expired"]) {
      expect(() => listReviewsQuerySchema.parse({ status: s })).not.toThrow();
    }
  });

  it("rejects an unknown status value", () => {
    expect(() => listReviewsQuerySchema.parse({ status: "unknown" })).toThrow();
  });

  it("rejects an unknown type value", () => {
    expect(() => listReviewsQuerySchema.parse({ type: "invalid" })).toThrow();
  });

  it("rejects extra keys (.strict())", () => {
    expect(() => listReviewsQuerySchema.parse({ extra: "field" })).toThrow();
  });

  it("accepts an empty object — all fields optional", () => {
    expect(() => listReviewsQuerySchema.parse({})).not.toThrow();
  });
});

describe("listDueReviewsQuerySchema", () => {
  it("accepts a valid cursor pair", () => {
    expect(() =>
      listDueReviewsQuerySchema.parse({
        afterDueAt: "2026-09-01T00:00:00.000Z",
        afterId: "42",
      }),
    ).not.toThrow();
  });

  it("accepts an empty object — no cursor", () => {
    expect(() => listDueReviewsQuerySchema.parse({})).not.toThrow();
  });

  it("rejects afterDueAt without afterId", () => {
    expect(() =>
      listDueReviewsQuerySchema.parse({ afterDueAt: "2026-09-01T00:00:00.000Z" }),
    ).toThrow();
  });

  it("rejects afterId without afterDueAt", () => {
    expect(() => listDueReviewsQuerySchema.parse({ afterId: "42" })).toThrow();
  });

  it("rejects an invalid datetime for afterDueAt", () => {
    expect(() =>
      listDueReviewsQuerySchema.parse({ afterDueAt: "not-a-date", afterId: "42" }),
    ).toThrow();
  });

  it("rejects extra keys (.strict())", () => {
    expect(() => listDueReviewsQuerySchema.parse({ extra: "field" })).toThrow();
  });

  it("rejects an empty afterId string", () => {
    expect(() =>
      listDueReviewsQuerySchema.parse({
        afterDueAt: "2026-09-01T00:00:00.000Z",
        afterId: "",
      }),
    ).toThrow();
  });
});
