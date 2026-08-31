import { idCursorSchema } from "./cursor.schema";

/**
 * The criterion is "a malformed or stale cursor returns the first page rather
 * than an error". For a numeric keyset cursor that means parsing to `undefined`,
 * because `undefined` is what the reader passes when it wants the newest page.
 */
describe("idCursorSchema", () => {
  it("accepts a positive integer", () => {
    expect(idCursorSchema.parse("42")).toBe(42);
    expect(idCursorSchema.parse(42)).toBe(42);
  });

  it("treats an absent cursor as the first page", () => {
    expect(idCursorSchema.parse(undefined)).toBeUndefined();
  });

  const malformed: readonly [string, unknown][] = [
    ["a hand-edited string", "abc"],
    ["an empty string", ""],
    ["zero", "0"],
    ["a negative id", "-5"],
    ["a fraction", "1.5"],
    ["a float that lost precision", 1.0000001],
    ["null", null],
    ["a boolean", true],
    ["an object", { id: 5 }],
    ["an array", [1, 2]],
    ["Infinity", "Infinity"],
    ["NaN", "NaN"],
  ];

  it.each(malformed)("returns the first page for %s", (_label, value) => {
    expect(idCursorSchema.parse(value)).toBeUndefined();
  });

  it("never throws for any of them, so a bookmarked link degrades instead of 400ing", () => {
    for (const [, value] of malformed) expect(() => idCursorSchema.parse(value)).not.toThrow();
  });

  it("keeps a stale-but-well-formed cursor, which the query answers as the first page", () => {
    expect(idCursorSchema.parse("999999999")).toBe(999999999);
  });
});
