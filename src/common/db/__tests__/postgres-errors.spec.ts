import { isUniqueViolation, postgresErrorCode } from "../postgres-errors";

/**
 * The case that matters is the wrapped one: reading `.code` off the thrown value
 * is what 53 files in this repository do, and against Drizzle it matches
 * nothing.
 */
class DrizzleQueryErrorLike extends Error {
  constructor(override readonly cause: unknown) {
    super("Failed query");
  }
}

describe("postgres error classification", () => {
  it("finds the code on a bare driver error", () => {
    expect(isUniqueViolation(Object.assign(new Error("dup"), { code: "23505" }))).toBe(true);
  });

  it("finds the code through Drizzle's wrapper, which is the whole point", () => {
    const wrapped = new DrizzleQueryErrorLike(
      Object.assign(new Error("duplicate key"), { code: "23505" }),
    );
    // The naive check — `wrapped.code === "23505"` — is false here, which is
    // why every handler written that way silently caught nothing.
    expect((wrapped as unknown as { code?: string }).code).toBeUndefined();
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("does not confuse one constraint class for another", () => {
    const fk = new DrizzleQueryErrorLike(Object.assign(new Error("fk"), { code: "23503" }));
    expect(isUniqueViolation(fk)).toBe(false);
    expect(postgresErrorCode(fk)).toBe("23503");
  });

  it("terminates on a self-referential cause rather than hanging", () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(isUniqueViolation(looped)).toBe(false);
  });

  it("answers null for things that are not errors", () => {
    expect(postgresErrorCode(null)).toBeNull();
    expect(postgresErrorCode("23505")).toBeNull();
  });
});
