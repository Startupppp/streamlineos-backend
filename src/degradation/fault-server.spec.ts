import { FaultServer, refusedPort } from "./fault-server";

const FETCH_TIMEOUT_MS = 400;

function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

describe("FaultServer — blackhole mode", () => {
  let server: FaultServer;

  beforeAll(async () => {
    server = new FaultServer({ mode: "blackhole" });
    await server.start();
  });

  afterAll(() => server.stop());

  it("accepts the socket but never responds, causing the request to hang until aborted", async () => {
    await expect(fetchWithTimeout(server.url, FETCH_TIMEOUT_MS)).rejects.toThrow();
  });

  it("switching to error mode ends the hang and returns the configured status", async () => {
    server.mode = "error";
    server.statusCode = 503;
    const res = await fetchWithTimeout(server.url, FETCH_TIMEOUT_MS);
    expect(res.status).toBe(503);
    server.mode = "blackhole";
  });
});

describe("FaultServer — error mode", () => {
  let server: FaultServer;

  beforeAll(async () => {
    server = new FaultServer({ mode: "error", statusCode: 503 });
    await server.start();
  });

  afterAll(() => server.stop());

  it("responds with the configured HTTP status code", async () => {
    const res = await fetch(server.url);
    expect(res.status).toBe(503);
  });

  it("responds with a configurable body", async () => {
    server.body = "unavailable";
    const res = await fetch(server.url);
    const text = await res.text();
    expect(text).toBe("unavailable");
  });
});

describe("FaultServer — slow mode", () => {
  let server: FaultServer;

  beforeAll(async () => {
    server = new FaultServer({ mode: "slow", delayMs: 250 });
    await server.start();
  });

  afterAll(() => server.stop());

  it("responds after the configured delay, not before", async () => {
    const start = Date.now();
    const res = await fetch(server.url);
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  it("a client with a shorter timeout receives a timeout error", async () => {
    server.delayMs = 500;
    await expect(fetchWithTimeout(server.url, 200)).rejects.toThrow();
    server.delayMs = 250;
  });
});

describe("refusedPort", () => {
  it("returns a port with no server listening — connection is refused immediately", async () => {
    const port = await refusedPort();
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
  });
});
