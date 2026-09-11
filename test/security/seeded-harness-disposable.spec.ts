import { assertDisposableDatabase } from "../helpers/disposable-database";

describe("seeded e2e harness targets a disposable database", () => {
  it("refuses the shared development database", () => {
    const verdict = assertDisposableDatabase("postgres://u:p@host/neondb");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("neondb");
  });

  it("refuses a production-looking database", () => {
    expect(assertDisposableDatabase("postgres://u:p@host/streamlineos").ok).toBe(false);
  });

  it("accepts a scratch database", () => {
    const verdict = assertDisposableDatabase("postgres://u:p@host/scratch_e2e?sslmode=require");
    expect(verdict).toEqual({ ok: true, database: "scratch_e2e" });
  });

  it("refuses an unparseable url rather than defaulting to allow", () => {
    expect(assertDisposableDatabase("not a url").ok).toBe(false);
  });
});
