/**
 * The SSRF guard resolves the hostname for real — that is the point of it — so a
 * spec that names a public host would depend on this machine's DNS. Only the
 * name lookup is stubbed; every address decision below is still the shared
 * guard's, including the packed IPv4-mapped form.
 */
jest.mock("node:dns/promises", () => ({
  lookup: jest.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

import { WebhookTransportService } from "../webhook-transport.service";
import {
  WEBHOOK_ATTEMPT_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  verifyWebhookSignature,
} from "../webhook-signature";

describe("WebhookTransportService", () => {
  const transport = new WebhookTransportService();
  const secret = "s".repeat(64);
  const target = { id: 7, url: "https://hooks.example.com/inv", secret };
  const event = {
    id: 4213,
    eventType: "inventory.stock.changed" as const,
    payload: { sku: "X-1" },
    createdAt: new Date("2026-08-28T00:00:00.000Z"),
    attempt: 3,
  };

  const fetchSpy = jest.spyOn(globalThis, "fetch");

  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());

  function captureRequest() {
    fetchSpy.mockResolvedValue({ ok: true, status: 200, type: "default" } as Response);
    return async () => {
      const outcome = await transport.deliver(target, event, { requireHttps: true });
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      return { outcome, init, headers: init.headers as Record<string, string> };
    };
  }

  it("signs what it actually sends, and the receiver's verifier accepts it", async () => {
    const { outcome, init, headers } = await captureRequest()();

    expect(outcome).toEqual({ ok: true, httpStatus: 200 });
    // The exact bytes on the wire, not a re-serialisation of the same object:
    // a signature over anything else is a signature a receiver cannot check.
    expect(
      verifyWebhookSignature({
        secret,
        header: headers[WEBHOOK_SIGNATURE_HEADER],
        rawBody: init.body as string,
      }),
    ).toEqual({ valid: true });
  });

  it("sends the timestamp and a stable event id beside the signature", async () => {
    const { headers } = await captureRequest()();

    // The timestamp is what makes the window checkable; the event id is stable
    // across retries so an at-least-once delivery can be deduped by the receiver.
    expect(headers[WEBHOOK_TIMESTAMP_HEADER]).toMatch(/^\d+$/);
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toContain(`t=${headers[WEBHOOK_TIMESTAMP_HEADER]}`);
    expect(headers[WEBHOOK_EVENT_ID_HEADER]).toBe("4213");
    expect(headers[WEBHOOK_ATTEMPT_HEADER]).toBe("3");
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).not.toMatch(/^sha256=/);
  });

  it("never follows a redirect", async () => {
    // A permitted host answering 302 to an internal address defeats the SSRF
    // resolution check entirely, so a redirect is a failed delivery, not a hop.
    const { init } = await captureRequest()();
    expect(init.redirect).toBe("manual");

    fetchSpy.mockResolvedValue({ ok: false, status: 302, type: "default" } as Response);
    await expect(transport.deliver(target, event, { requireHttps: true })).resolves.toEqual({
      ok: false,
      httpStatus: 302,
      error: "redirect-refused:302",
    });
  });

  it.each([
    ["loopback", "https://127.0.0.1/hook"],
    ["the packed IPv4-mapped loopback new URL() actually produces", "https://[::ffff:127.0.0.1]/hook"],
    ["cloud metadata", "https://169.254.169.254/latest/meta-data"],
    ["private space", "https://10.0.0.5/hook"],
  ])("refuses to send to %s, re-checked on every attempt", async (_label, url) => {
    const outcome = await transport.deliver({ ...target, url }, event, { requireHttps: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      ok: false,
      httpStatus: null,
      error: "ssrf-guard:blocked-address",
    });
  });

  it("refuses plaintext in production", async () => {
    const outcome = await transport.deliver(
      { ...target, url: "http://hooks.example.com/inv" },
      event,
      { requireHttps: true },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, error: "ssrf-guard:https-required-in-production" });
  });

  it("reports a non-2xx as a failure the retry policy can act on", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 503, type: "default" } as Response);

    await expect(transport.deliver(target, event, { requireHttps: true })).resolves.toEqual({
      ok: false,
      httpStatus: 503,
      error: "http:503",
    });
  });

  it("turns a transport error into a value rather than a throw", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(transport.deliver(target, event, { requireHttps: true })).resolves.toEqual({
      ok: false,
      httpStatus: null,
      error: "ECONNREFUSED",
    });
  });
});
