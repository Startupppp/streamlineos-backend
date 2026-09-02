import {
  decodeCursor,
  encodeCursor,
  isPartialGmailCursor,
  type OpaqueCursor,
} from "./providers/mail-normalizers";

const READER = "user-roundtrip";

function roundTrip(cursor: OpaqueCursor): OpaqueCursor {
  return decodeCursor(encodeCursor(cursor, READER), READER);
}

describe("mail cursor — every position survives the JSON round trip", () => {
  it("preserves a Gmail page token, an Outlook skip and a partial-page cursor byte for byte", () => {
    const cursor: OpaqueCursor = { 1: "gmail-page-token", 2: 40, 3: { token: "tok", skip: 7 } };

    const decoded = roundTrip(cursor);

    expect(decoded[1]).toBe("gmail-page-token");
    expect(decoded[2]).toBe(40);
    expect(isPartialGmailCursor(decoded[3])).toBe(true);
    expect(decoded[3]).toEqual({ token: "tok", skip: 7 });
  });

  it("keeps an exhausted account's explicit null, so it is never read back as 'no position yet'", () => {
    const decoded = roundTrip({ 1: null, 2: "still-going" });

    expect(Object.prototype.hasOwnProperty.call(decoded, "1")).toBe(true);
    expect(decoded[1]).toBeNull();
    expect(decoded[2]).toBe("still-going");
  });

  it("keeps falsy-but-real positions: an empty resume token and a zero skip", () => {
    const decoded = roundTrip({ 1: { token: "", skip: 12 }, 2: 0 });

    expect(decoded[1]).toEqual({ token: "", skip: 12 });
    expect(decoded[2]).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(decoded, "2")).toBe(true);
  });

  it("BITE: an undefined position vanishes in serialization and reads back as the first page", () => {
    const decoded = roundTrip({ 1: undefined, 2: "kept" });

    expect(Object.prototype.hasOwnProperty.call(decoded, "1")).toBe(false);
    expect(decoded[1]).toBeUndefined();
    expect(decoded[2]).toBe("kept");
  });

  it("survives repeated re-encoding, so page N's cursor still names every account at page N+1", () => {
    const original: OpaqueCursor = { 1: null, 2: { token: "t", skip: 3 }, 3: 9 };

    let carried = original;
    for (let i = 0; i < 4; i += 1) carried = roundTrip(carried);

    expect(carried).toEqual(original);
  });
});
