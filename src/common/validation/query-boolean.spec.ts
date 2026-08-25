import { z } from "zod";
import { queryBoolean } from "./query-boolean";

describe("queryBoolean", () => {
  /**
   * The reason this exists. `z.coerce.boolean()` is `Boolean(value)`, so every
   * non-empty string is true and a filter the caller switched off stays on.
   */
  it("reads a falsy query string as false, unlike z.coerce.boolean", () => {
    expect(z.coerce.boolean().parse("false")).toBe(true); // the bug, pinned
    expect(queryBoolean.parse("false")).toBe(false);
    expect(queryBoolean.parse("0")).toBe(false);
    expect(queryBoolean.parse("no")).toBe(false);
    expect(queryBoolean.parse("off")).toBe(false);
  });

  it("reads the truthy spellings", () => {
    for (const value of ["true", "1", "yes", "on", "TRUE", " True "])
      expect(queryBoolean.parse(value)).toBe(true);
  });

  it("treats a bare flag with no value as on", () => {
    // `?includeRoutine` arrives as an empty string; writing the flag at all is
    // what the caller meant by it.
    expect(queryBoolean.parse("")).toBe(true);
  });

  it("passes a real boolean through, so the same schema works in a body", () => {
    expect(queryBoolean.parse(true)).toBe(true);
    expect(queryBoolean.parse(false)).toBe(false);
  });

  it("rejects anything else rather than guessing", () => {
    // A caller who typed `?flag=maybe` deserves a 400, not a silent default.
    expect(() => queryBoolean.parse("maybe")).toThrow();
    expect(() => queryBoolean.parse("2")).toThrow();
    expect(() => queryBoolean.parse(null)).toThrow();
  });

  it("composes with optional and default the way a query schema needs", () => {
    const schema = z.object({
      a: queryBoolean.optional(),
      b: queryBoolean.default(false),
    });
    expect(schema.parse({})).toEqual({ b: false });
    expect(schema.parse({ a: "false", b: "true" })).toEqual({ a: false, b: true });
  });
});
