import { isTransientDbError } from "./transient-error";

describe("isTransientDbError", () => {
  it("detects ECONNRESET nested under a Drizzle 'Failed query' cause", () => {
    const err = Object.assign(new Error("Failed query: select ... from payroll_jobs"), {
      cause: { errno: -4077, code: "ECONNRESET", syscall: "read" },
    });
    expect(isTransientDbError(err)).toBe(true);
  });

  it("detects a top-level ECONNRESET code", () => {
    expect(isTransientDbError(Object.assign(new Error("boom"), { code: "ECONNRESET" }))).toBe(true);
  });

  it("detects postgres.js CONNECTION_ENDED", () => {
    expect(
      isTransientDbError(Object.assign(new Error("Connection ended"), { code: "CONNECTION_ENDED" })),
    ).toBe(true);
  });

  it("detects connection-failure SQLSTATE 08006", () => {
    expect(isTransientDbError(Object.assign(new Error("x"), { code: "08006" }))).toBe(true);
  });

  it("detects a transient error by message fragment", () => {
    expect(isTransientDbError(new Error("terminating connection due to administrator command"))).toBe(true);
  });

  it("returns false for a normal application error", () => {
    expect(isTransientDbError(new Error("Employee not found in your organization."))).toBe(false);
  });

  it("returns false for null / undefined", () => {
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
  });
});
