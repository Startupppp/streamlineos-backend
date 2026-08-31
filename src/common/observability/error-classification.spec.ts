import {
  isTenantContextError,
  SQLSTATE_INSUFFICIENT_PRIVILEGE,
  sqlstateOf,
} from "./error-classification";

/**
 * Shaped like the real thing: postgres-js builds `PostgresError` with
 * `super(x.message)` and `Object.assign(this, x)`, so the SQLSTATE lands on
 * `code` and the message carries only the server's text. Drizzle then wraps it.
 */
function postgresError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: "ERROR" });
}

function drizzleWrapped(cause: Error): Error {
  return Object.assign(new Error("Failed query: select * from notifications"), { cause });
}

describe("sqlstateOf", () => {
  it("reads the SQLSTATE off a bare driver error", () => {
    expect(sqlstateOf(postgresError("42501", "permission denied for table notifications"))).toBe(
      "42501",
    );
  });

  it("finds the SQLSTATE through Drizzle's wrapper", () => {
    const wrapped = drizzleWrapped(
      postgresError("42501", "permission denied for table notifications"),
    );
    expect(sqlstateOf(wrapped)).toBe("42501");
  });

  it("finds the SQLSTATE two cause links down", () => {
    expect(sqlstateOf(drizzleWrapped(drizzleWrapped(postgresError("23505", "duplicate key"))))).toBe(
      "23505",
    );
  });

  it("ignores a Node socket error code, which is not a SQLSTATE", () => {
    expect(sqlstateOf(postgresError("ECONNRESET", "socket hang up"))).toBeUndefined();
  });

  it("returns undefined for an error carrying no code", () => {
    expect(sqlstateOf(new Error("boom"))).toBeUndefined();
  });

  it("returns undefined for a non-error", () => {
    expect(sqlstateOf("boom")).toBeUndefined();
    expect(sqlstateOf(null)).toBeUndefined();
  });

  it("terminates on a cause chain that loops", () => {
    const a: { code?: string; cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect(sqlstateOf(a)).toBeUndefined();
  });
});

describe("isTenantContextError", () => {
  it("recognises a missing tenant GUC through the wrapper", () => {
    const wrapped = drizzleWrapped(
      postgresError(SQLSTATE_INSUFFICIENT_PRIVILEGE, "permission denied for table notifications"),
    );
    expect(isTenantContextError(wrapped)).toBe(true);
  });

  it("does not claim an unrelated database error", () => {
    expect(isTenantContextError(postgresError("23505", "duplicate key value"))).toBe(false);
  });
});
