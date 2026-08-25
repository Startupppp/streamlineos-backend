import { createServer } from "node:http";
import type { Server } from "node:http";
import { outboundRequest, OutboundRequestError } from "./outbound-request";

jest.mock("../logger/logger.service", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../security/ssrf-guard", () => ({
  checkWebhookUrl: jest.fn(),
}));

import { checkWebhookUrl } from "../security/ssrf-guard";
const mockCheckWebhookUrl = checkWebhookUrl as jest.MockedFunction<typeof checkWebhookUrl>;

function listenOnFreePort(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("unexpected address type"));
        return;
      }
      resolve(addr.port);
    });
  });
}

describe("outboundRequest — hanging server is abandoned at the deadline", () => {
  let hangingServer: Server;
  let port: number;

  beforeAll(async () => {
    hangingServer = createServer((_req, _res) => {});
    port = await listenOnFreePort(hangingServer);
    mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
  });

  afterAll((done) => {
    hangingServer.close(done);
  });

  it("rejects with OutboundRequestError outcome=timeout within the deadline", async () => {
    const start = Date.now();
    let caught: unknown;
    try {
      await outboundRequest(`http://127.0.0.1:${port}/`, {
        provider: "test-hanging",
        timeoutMs: 200,
      });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(OutboundRequestError);
    expect((caught as OutboundRequestError).outcome).toBe("timeout");
    expect((caught as OutboundRequestError).provider).toBe("test-hanging");
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("outboundRequest — SSRF rejection delegates to checkWebhookUrl", () => {
  it("throws ssrf-blocked when the guard returns allowed: false", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: false, reason: "blocked-address" });
    let caught: unknown;
    try {
      await outboundRequest("http://192.168.1.1/secret", {
        provider: "test-ssrf",
        timeoutMs: 5_000,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OutboundRequestError);
    expect((caught as OutboundRequestError).outcome).toBe("ssrf-blocked");
    expect((caught as OutboundRequestError).provider).toBe("test-ssrf");
  });
});

describe("outboundRequest — caller-supplied signal", () => {
  let slowServer: Server;
  let port: number;

  beforeAll(async () => {
    slowServer = createServer((_req, _res) => {});
    port = await listenOnFreePort(slowServer);
    mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
  });

  afterAll((done) => {
    slowServer.close(done);
  });

  it("aborts when the caller signal fires before the helper timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      outboundRequest(`http://127.0.0.1:${port}/`, {
        provider: "test-caller-signal",
        timeoutMs: 10_000,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(OutboundRequestError);
  });
});
