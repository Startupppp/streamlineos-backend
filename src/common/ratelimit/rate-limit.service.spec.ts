import { RateLimitService } from "./rate-limit.service";

describe("RateLimitService (in-memory fallback, no redis)", () => {
  const svc = new RateLimitService(null);

  it("allows up to the limit then blocks within the window", async () => {
    const id = "k1";
    const results: boolean[] = [];
    for (let i = 0; i < 62; i++) results.push((await svc.check("api-key-ingest", id)).allowed);
    expect(results.slice(0, 60).every((r) => r === true)).toBe(true);
    expect(results[60]).toBe(false);
  });

  it("isolates different identifiers", async () => {
    expect((await svc.check("api-key-ingest", "a")).allowed).toBe(true);
    expect((await svc.check("api-key-ingest", "b")).allowed).toBe(true);
  });

  it("allows any identifier for an unknown tier", async () => {
    expect((await svc.check("unknown-tier", "x")).allowed).toBe(true);
  });
});
