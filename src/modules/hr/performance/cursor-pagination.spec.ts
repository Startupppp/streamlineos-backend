import { BadRequestException } from "@nestjs/common";
import { decodeTimestampCursor, encodeTimestampCursor } from "./cursor-pagination";

describe("timestamp cursor pagination", () => {
  it("round-trips the deterministic createdAt/id boundary", () => {
    const createdAt = new Date("2026-08-04T10:15:30.000Z");
    expect(decodeTimestampCursor(encodeTimestampCursor({ createdAt, id: 42 }))).toEqual({
      createdAt,
      id: 42,
    });
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeTimestampCursor("not-a-cursor")).toThrow(BadRequestException);
  });
});
