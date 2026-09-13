import {
  assertDisposableTarget,
  assertDisposableApiTarget,
  assertEmailTransportDisabled,
  assertNotProductionDatabase,
} from "./measure-org-setup-journey";

describe("measure-org-setup-journey refusal guards", () => {
  it("combined (a): local scratch DB is allowed but remote API is refused — proves API check bites even when DB is valid", () => {
    const db = assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/scratch_local", "scratch_local", false);
    const api = assertDisposableApiTarget("http://api.prod.streamlineos.com:443", false);
    expect(db.allowed).toBe(true);
    expect(api.allowed).toBe(false);
    expect(api.reason).toContain("api.prod.streamlineos.com");
  });

  it("combined (b): local scratch DB is allowed but undefined/wrong API is refused — proves API check bites even when DB is valid", () => {
    const db = assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/scratch_local", "scratch_local", false);
    const api = assertDisposableApiTarget(undefined, false);
    expect(db.allowed).toBe(true);
    expect(api.allowed).toBe(false);
    expect(api.reason).toContain("required");
  });

  it("combined: local scratch DB is allowed but invalid-URL API is refused", () => {
    const db = assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/scratch_local", "scratch_local", false);
    const api = assertDisposableApiTarget("not-a-url", false);
    expect(db.allowed).toBe(true);
    expect(api.allowed).toBe(false);
  });

  it("production DB URL refused regardless of SETUP_ALLOW_REMOTE — neon.tech", () => {
    const result = assertNotProductionDatabase("postgresql://u:p@db.neon.tech:5432/scratch_local");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("neon.tech");
  });

  it("production DB URL refused regardless of SETUP_ALLOW_REMOTE — amazonaws.com", () => {
    const result = assertNotProductionDatabase("postgresql://u:p@prod.cluster.rds.amazonaws.com:5432/streamlineos");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("amazonaws.com");
  });

  it("loopback scratch URL passes the production host check", () => {
    expect(assertNotProductionDatabase("postgresql://u:p@127.0.0.1:5432/scratch_local").allowed).toBe(true);
    expect(assertNotProductionDatabase("postgresql://u:p@localhost:5432/scratch_local").allowed).toBe(true);
  });

  it("refusal functions are synchronous pure functions — fetch is never called during refusal checks, proving refusal precedes any request", () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = () => {
      fetchCalled = true;
      return Promise.reject(new Error("fetch must not be called during refusal checks"));
    };
    try {
      assertDisposableTarget("postgresql://u:p@db.prod.example:5432/scratch_local", "scratch_local", false);
      assertDisposableApiTarget("http://api.prod.example:1600", false);
      assertNotProductionDatabase("postgresql://u:p@db.neon.tech:5432/scratch");
      assertEmailTransportDisabled({ ZEPTOMAIL_TOKEN: "tok" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchCalled).toBe(false);
  });

  it("combined: production DB + remote API both refused independently — neither check depends on the other", () => {
    const db = assertNotProductionDatabase("postgresql://u:p@db.neon.tech:5432/scratch_local");
    const api = assertDisposableApiTarget("http://api.prod.streamlineos.com:443", false);
    expect(db.allowed).toBe(false);
    expect(api.allowed).toBe(false);
  });
});
