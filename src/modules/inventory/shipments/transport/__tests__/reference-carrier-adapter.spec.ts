import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createCarrierHttp } from "../carrier-http";
import { ReferenceHttpCarrierAdapter } from "../reference-http.adapter";
import {
  webhookSignatureHeaderValue,
  WEBHOOK_SIGNATURE_HEADER,
} from "../../../webhooks/webhook-signature";
import type { CarrierAccount } from "../carrier-transport.port";

/**
 * INV-26 — the carrier adapter, exercised against a real HTTP server this file
 * starts.
 *
 * ## Why a stub server rather than a mocked `fetch`
 *
 * Because the parts worth testing are the ones a `fetch` mock replaces: that
 * the credential goes in a header and not in the URL, that a 4xx becomes
 * `rejected` while a 5xx becomes `unavailable`, that a redirect is refused
 * rather than followed, that an unreadable body does not become a silent
 * success. A mock asserts that the adapter called a function; a socket asserts
 * that the adapter speaks HTTP.
 *
 * ## Why it is still not an integration test
 *
 * There is no courier here, and there is no courier anywhere in this
 * repository — the wire format below is one this repository defined, because
 * which courier ships first is a product decision that has not been taken.
 * What the stub stands in for is the *failure modes* a courier has, which are
 * exactly the things a real sandbox makes hard to produce on demand: refusing a
 * booking, answering 503, redirecting, returning a shape the adapter cannot
 * read.
 *
 * ## The one production behaviour this deliberately disables
 *
 * The SSRF guard, which blocks loopback — correctly, and that is the whole
 * reason a test against a server on 127.0.0.1 has to get past it. It is passed
 * as a parameter rather than mocked away globally, so production still gets the
 * real one by default; the guard's own behaviour is covered by
 * `ssrf-guard.spec.ts` and by `webhook-transport.service.spec.ts`, which proves
 * that a loopback target IS refused on the sibling seam.
 */

interface StubRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

/** What the stub answers next, set per test. */
interface StubPlan {
  status: number;
  body: unknown;
  /** Sent verbatim when set, so a malformed body can be tested. */
  raw?: string;
  location?: string;
}

describe("the reference carrier adapter, against a stub courier", () => {
  let server: Server;
  let baseUrl: string;
  let requests: StubRequest[] = [];
  let plans = new Map<string, StubPlan>();

  const account = (): CarrierAccount => ({
    carrierCode: "STUBX",
    baseUrl,
    credential: "sandbox-key-3f9a",
  });

  /**
   * The adapter under test, wired to the real HTTP client with only the URL
   * check replaced. Everything else — the timeout, `redirect: "manual"`, the
   * JSON reading — is the production path.
   */
  const adapter = new ReferenceHttpCarrierAdapter(
    createCarrierHttp({ urlCheck: () => Promise.resolve({ allowed: true }) }),
  );

  function plan(key: string, value: StubPlan): void {
    plans.set(key, value);
  }

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const url = req.url ?? "";
        requests.push({
          method: req.method ?? "",
          url,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const answer = plans.get(`${req.method ?? ""} ${url}`) ?? {
          status: 404,
          body: { errors: [{ code: "not_found", message: "no plan for this route" }] },
        };
        if (answer.location) {
          res.writeHead(answer.status, { Location: answer.location });
          res.end();
          return;
        }
        res.writeHead(answer.status, { "Content-Type": "application/json" });
        res.end(answer.raw ?? JSON.stringify(answer.body));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "string" ? 0 : (address as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${String(port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    requests = [];
    plans = new Map();
  });

  it("books a consignment and reports what the courier actually returned", async () => {
    plan("POST /shipments", {
      status: 201,
      body: {
        consignmentId: "CONS-77",
        trackingNumber: "STUBX-000123",
        label: { url: "https://labels.example.com/CONS-77.pdf", format: "PDF" },
      },
    });

    const result = await adapter.book(account(), {
      shipmentNumber: "SHP-1",
      destinationAddress: "12 Warehouse Road",
      parcels: [
        {
          reference: "PKG-1",
          declaredWeight: "2.5000",
          declaredLength: "30.00",
          declaredWidth: "20.00",
          declaredHeight: "10.00",
        },
      ],
    });

    expect(result).toEqual({
      outcome: "accepted",
      value: {
        carrierReference: "CONS-77",
        trackingNumber: "STUBX-000123",
        label: { url: "https://labels.example.com/CONS-77.pdf", format: "PDF" },
      },
    });

    // Nothing is minted locally: the tracking number in the answer is the one
    // the server on the socket sent, which is the property that stops this
    // becoming INV-27's fake adapter.
    const sent = requests[0];
    expect(sent?.method).toBe("POST");
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({
      reference: "SHP-1",
      destination: "12 Warehouse Road",
      parcels: [
        {
          reference: "PKG-1",
          declaredWeight: "2.5000",
          declaredLength: "30.00",
          declaredWidth: "20.00",
          declaredHeight: "10.00",
        },
      ],
    });
  });

  it("puts the credential in a header and never in the URL", async () => {
    plan("POST /shipments", {
      status: 200,
      body: { consignmentId: "C-1", trackingNumber: "T-1" },
    });

    await adapter.book(account(), {
      shipmentNumber: "SHP-2",
      destinationAddress: null,
      parcels: [],
    });

    // A query string is written to every proxy log between here and the
    // courier; a header is not.
    expect(requests[0]?.authorization).toBe("Bearer sandbox-key-3f9a");
    expect(requests[0]?.url).not.toContain("sandbox-key");
  });

  it("reports a refused booking as rejected, carrying the courier's own errors", async () => {
    plan("POST /shipments", {
      status: 422,
      body: {
        errors: [
          { code: "invalid_postcode", message: "Destination postcode is not serviceable" },
        ],
      },
    });

    const result = await adapter.book(account(), {
      shipmentNumber: "SHP-3",
      destinationAddress: "Nowhere",
      parcels: [],
    });

    // `rejected`, not `unavailable`: the courier read the request and said no,
    // and the distinction is what stops a caller retrying it forever.
    expect(result).toEqual({
      outcome: "rejected",
      errors: [{ code: "invalid_postcode", message: "Destination postcode is not serviceable" }],
    });
    expect(requests).toHaveLength(1);
  });

  it("reports a courier that is down as unavailable rather than rejected", async () => {
    plan("POST /shipments", { status: 503, body: { message: "maintenance" } });

    const result = await adapter.book(account(), {
      shipmentNumber: "SHP-4",
      destinationAddress: null,
      parcels: [],
    });

    expect(result.outcome).toBe("unavailable");
  });

  it("fetches a label for a consignment the courier has already accepted", async () => {
    plan("GET /shipments/CONS-77/label", {
      status: 200,
      body: { url: "https://labels.example.com/CONS-77.pdf", format: "PDF" },
    });

    const result = await adapter.fetchLabel(account(), "CONS-77");

    expect(result).toEqual({
      outcome: "accepted",
      value: { url: "https://labels.example.com/CONS-77.pdf", format: "PDF" },
    });
  });

  it("reports a label that is not ready yet as a rejection an operator can read", async () => {
    plan("GET /shipments/CONS-77/label", {
      status: 404,
      body: { errors: [{ code: "label_pending", message: "Label is still being generated" }] },
    });

    const result = await adapter.fetchLabel(account(), "CONS-77");

    expect(result).toEqual({
      outcome: "rejected",
      errors: [{ code: "label_pending", message: "Label is still being generated" }],
    });
  });

  it("reads a tracking update into our vocabulary, keyed on OUR tracking number", async () => {
    plan("GET /tracking/STUBX-000123", {
      status: 200,
      body: {
        events: [
          {
            id: "evt-9",
            status: "SHIPPED",
            occurredAt: "2026-09-11T08:00:00.000Z",
            description: "Collected from sender",
          },
          { id: "evt-10", status: "DELIVERED", occurredAt: "2026-09-12T09:30:00.000Z" },
        ],
      },
    });

    const result = await adapter.track(account(), "STUBX-000123");

    expect(result).toEqual({
      outcome: "accepted",
      value: [
        {
          trackingNumber: "STUBX-000123",
          status: "SHIPPED",
          occurredAt: "2026-09-11T08:00:00.000Z",
          carrierEventId: "evt-9",
          description: "Collected from sender",
        },
        {
          trackingNumber: "STUBX-000123",
          status: "DELIVERED",
          occurredAt: "2026-09-12T09:30:00.000Z",
          carrierEventId: "evt-10",
        },
      ],
    });
  });

  it("refuses to read a 2xx it cannot parse, rather than calling it a success", async () => {
    plan("POST /shipments", { status: 200, body: null, raw: "<html>maintenance</html>" });

    const result = await adapter.book(account(), {
      shipmentNumber: "SHP-5",
      destinationAddress: null,
      parcels: [],
    });

    // Not `rejected`: the courier believes it succeeded, and calling this a
    // rejection would invite a caller to book the same parcel again.
    expect(result.outcome).toBe("unavailable");
  });

  it("never follows a redirect, because a permitted host can 302 inwards", async () => {
    plan("POST /shipments", { status: 302, body: null, location: "http://169.254.169.254/" });

    const result = await adapter.book(account(), {
      shipmentNumber: "SHP-6",
      destinationAddress: null,
      parcels: [],
    });

    expect(result).toEqual({ outcome: "unavailable", reason: "redirect-refused:302" });
  });

  it("verifies a callback signed with the tenant's secret and refuses a tampered one", () => {
    const secret = "s".repeat(48);
    const body = JSON.stringify({
      eventId: "evt-11",
      trackingNumber: "STUBX-000123",
      status: "DELIVERED",
      occurredAt: "2026-09-12T09:30:00.000Z",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const header = webhookSignatureHeaderValue(secret, timestamp, body);

    expect(
      adapter.verifyWebhook({
        secret,
        rawBody: body,
        headers: { [WEBHOOK_SIGNATURE_HEADER.toLowerCase()]: header },
      }),
    ).toEqual({ valid: true });

    // One byte of the signed body changes the preimage, so the attacker needs
    // the secret to re-sign rather than merely to replay.
    expect(
      adapter.verifyWebhook({
        secret,
        rawBody: body.replace("DELIVERED", "CANCELLED"),
        headers: { [WEBHOOK_SIGNATURE_HEADER.toLowerCase()]: header },
      }),
    ).toEqual({ valid: false, reason: "signature-mismatch" });

    expect(adapter.verifyWebhook({ secret, rawBody: body, headers: {} })).toEqual({
      valid: false,
      reason: "malformed-signature",
    });
  });

  it("reads a callback into the same event shape the in-app POST is validated into", () => {
    const parsed = adapter.parseWebhook(
      JSON.stringify({
        eventId: "evt-12",
        trackingNumber: "STUBX-000123",
        status: "DELIVERED",
        occurredAt: "2026-09-12T09:30:00.000Z",
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      value: {
        eventKey: "evt-12",
        event: {
          trackingNumber: "STUBX-000123",
          status: "DELIVERED",
          occurredAt: "2026-09-12T09:30:00.000Z",
          carrierEventId: "evt-12",
        },
      },
    });

    expect(adapter.parseWebhook("not json").ok).toBe(false);
    expect(adapter.parseWebhook(JSON.stringify({ trackingNumber: "X" })).ok).toBe(false);
  });
});
