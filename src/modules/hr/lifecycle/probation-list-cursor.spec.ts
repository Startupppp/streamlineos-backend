import { BadRequestException } from "@nestjs/common";
import {
  decodeProbationListCursor,
  encodeProbationListCursor,
} from "./probation-list-cursor";

describe("probation list cursor", () => {
  it("round-trips the effective end date and review id", () => {
    const value = { effectiveEndDate: "2026-08-31", probationReviewId: 42 };
    expect(decodeProbationListCursor(encodeProbationListCursor(value))).toEqual(value);
  });

  it.each([
    "not-base64-json",
    Buffer.from(
      JSON.stringify({
        v: 1,
        effectiveEndDate: "tomorrow",
        probationReviewId: 1,
      }),
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        v: 1,
        effectiveEndDate: "2026-08-31",
        probationReviewId: 0,
      }),
    ).toString("base64url"),
  ])("rejects malformed cursors", (value) => {
    expect(() => decodeProbationListCursor(value)).toThrow(BadRequestException);
  });
});
