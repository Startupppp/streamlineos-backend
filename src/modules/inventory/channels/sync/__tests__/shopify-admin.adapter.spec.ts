import { ShopifyAdminAdapter } from "../shopify-admin.adapter";
import { SHOPIFY_DEFAULT_API_VERSION } from "../shopify-admin.contract";
import type { ChannelTarget } from "../channel-commerce.port";
import { startShopifyStub, type ShopifyStub } from "./shopify-stub-server";

/**
 * INV-27 — the Shopify adapter, against a Shopify that is a `node:http` server
 * started inside this file on a port the OS picked.
 *
 * No network, no sandbox account, no mocked `fetch`. The adapter builds real
 * URLs, sends a real header, reads a real Link header and parses a real body, so
 * the things a `jest.fn()` for `fetch` would never catch — a wrong path, a
 * credential on the query string, a 5xx read as a rejection — are the things
 * these assert.
 *
 * What this does NOT prove is that Shopify's API looks like the stub. Nothing
 * short of a store can prove that, and the adapter's own header says so.
 */

const TOKEN = "shpat_stub_token";
const LOCATION = 8877;

function makeAdapter(overrides: Partial<{ token: string | undefined; timeoutMs: number }> = {}) {
  return new ShopifyAdminAdapter({
    INV_CHANNEL_SHOPIFY_ACCESS_TOKEN: "token" in overrides ? overrides.token : TOKEN,
    INV_CHANNEL_SHOPIFY_API_VERSION: SHOPIFY_DEFAULT_API_VERSION,
    INV_CHANNEL_SHOPIFY_TIMEOUT_MS: overrides.timeoutMs ?? 2_000,
  });
}

function targetFor(stub: ShopifyStub): ChannelTarget {
  return {
    channelType: "SHOPIFY",
    storeUrl: stub.url,
    settings: { storeUrl: stub.url, shopifyLocationId: LOCATION },
  };
}

/** Two variants, so "the store has never heard of this SKU" is expressible. */
const PRODUCTS = {
  products: [
    {
      id: 1,
      variants: [
        { id: 11, sku: "SKU-A", inventory_item_id: 111 },
        { id: 12, sku: "SKU-B", inventory_item_id: 112 },
      ],
    },
  ],
};

describe("INV-27 — Shopify stock sync", () => {
  let stub: ShopifyStub;

  beforeAll(async () => {
    stub = await startShopifyStub([
      { match: "GET products.json", body: PRODUCTS },
      {
        match: "POST inventory_levels/set.json",
        body: { inventory_level: { inventory_item_id: 111, location_id: LOCATION, available: 4 } },
      },
      {
        match: "GET inventory_levels.json",
        body: {
          inventory_levels: [
            { inventory_item_id: 111, location_id: LOCATION, available: 7 },
            // Null is "not stocked here", which must never read as zero.
            { inventory_item_id: 112, location_id: LOCATION, available: null },
          ],
        },
      },
    ]);
  });

  afterAll(() => stub.close());
  beforeEach(() => {
    stub.requests.length = 0;
  });

  it("pushes availability and reports what the store took", async () => {
    const result = await makeAdapter().pushStock(targetFor(stub), [
      { sku: "SKU-A", quantity: "4.0000" },
      { sku: "SKU-B", quantity: "0.0000" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accepted).toEqual(["SKU-A", "SKU-B"]);
    expect(result.refused).toEqual([]);

    // The request the store actually received, not the one we meant to send.
    const sets = stub.requests.filter((request) => request.path.startsWith("inventory_levels/set"));
    expect(sets).toHaveLength(2);
    expect(sets[0]!.body).toEqual({
      location_id: LOCATION,
      inventory_item_id: 111,
      available: 4,
    });
  });

  it("sends the access token on Shopify's header and never on the query string", async () => {
    // A mocked `fetch` would have let either of these through. The credential
    // ending up in a URL is the version of this bug that also ends up in an
    // access log and a proxy's history.
    await makeAdapter().pushStock(targetFor(stub), [{ sku: "SKU-A", quantity: "1.0000" }]);

    expect(stub.requests.length).toBeGreaterThan(0);
    for (const request of stub.requests) {
      expect(request.token).toBe(TOKEN);
      expect(request.path).not.toContain(TOKEN);
    }
  });

  it("floors a fractional quantity rather than rounding it", async () => {
    // Offering 3 when 2.6 are on the shelf is an oversell, and an oversell on a
    // marketplace is a cancelled order and a seller-performance penalty.
    await makeAdapter().pushStock(targetFor(stub), [{ sku: "SKU-A", quantity: "2.6000" }]);

    const set = stub.requests.find((request) => request.path.startsWith("inventory_levels/set"));
    expect(set?.body).toMatchObject({ available: 2 });
  });

  it("refuses a SKU the store does not carry, without failing the push", async () => {
    const result = await makeAdapter().pushStock(targetFor(stub), [
      { sku: "SKU-A", quantity: "4.0000" },
      { sku: "SKU-GHOST", quantity: "9.0000" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The distinction the port exists for: one SKU was refused, the call was
    // not. Failing the whole push would re-send SKU-A on every retry.
    expect(result.accepted).toEqual(["SKU-A"]);
    expect(result.refused).toEqual([
      { sku: "SKU-GHOST", reason: "No Shopify variant carries this SKU" },
    ]);
  });

  it("pulls the store's own figures, and reports an unstocked item as unanswered", async () => {
    const snapshot = await makeAdapter().fetchSnapshot({
      channelType: "SHOPIFY",
      storeUrl: stub.url,
      skus: ["SKU-A", "SKU-B", "SKU-GHOST"],
    });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    // SKU-A has a figure. SKU-B is stocked nowhere (`available: null`) and
    // SKU-GHOST is not in the catalogue: neither becomes a zero, which is the
    // rule the whole snapshot path turns on.
    expect(snapshot.items).toEqual([{ sku: "SKU-A", quantity: "7.0000" }]);
    expect(snapshot.failures).toEqual(["SKU-GHOST"]);
    expect(snapshot.complete).toBe(false);
  });
});

describe("INV-27 — Shopify order import", () => {
  let stub: ShopifyStub;

  beforeAll(async () => {
    stub = await startShopifyStub([
      {
        match: "GET orders.json",
        body: {
          orders: [
            {
              id: 5001,
              name: "#1001",
              created_at: "2026-09-01T09:30:00Z",
              currency: "INR",
              shipping_address: { address1: "4 Nehru Road", city: "Pune", zip: "411001", country: "India" },
              line_items: [{ id: 90, sku: "SKU-A", quantity: 2, price: "199.00" }],
            },
          ],
        },
      },
    ]);
  });

  afterAll(() => stub.close());

  it("reads an order into our vocabulary, keyed on the channel's own order id", async () => {
    const result = await makeAdapter().fetchOrders(targetFor(stub), null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.complete).toBe(true);
    expect(result.orders).toEqual([
      {
        externalOrderId: "5001",
        externalOrderNumber: "#1001",
        placedAt: new Date("2026-09-01T09:30:00Z"),
        currency: "INR",
        shippingAddress: "4 Nehru Road, Pune, 411001, India",
        lines: [{ sku: "SKU-A", quantity: "2.0000", unitPrice: "199.00" }],
      },
    ]);
  });

  it("says a paged listing is incomplete rather than reporting a clean sweep", async () => {
    // A `Link: …rel="next"` means there are orders this run never saw. Reporting
    // `complete` here would mark the pull done over half the order book.
    stub.route({
      match: "GET orders.json",
      once: true,
      headers: { link: '<https://x.myshopify.com/admin/api/2024-10/orders.json?page_info=NEXT>; rel="next"' },
      body: { orders: [] },
    });

    const result = await makeAdapter().fetchOrders(targetFor(stub), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.complete).toBe(false);
  });

  it("passes `since` to the store as updated_at_min", async () => {
    stub.requests.length = 0;
    await makeAdapter().fetchOrders(targetFor(stub), new Date("2026-09-01T00:00:00Z"));
    expect(stub.requests[0]!.path).toContain("updated_at_min=2026-09-01T00%3A00%3A00.000Z");
  });
});

describe("INV-27 — Shopify ship confirm", () => {
  let stub: ShopifyStub;

  beforeAll(async () => {
    stub = await startShopifyStub([
      {
        match: "GET orders/5001/fulfillment_orders.json",
        body: {
          fulfillment_orders: [
            { id: 700, status: "open", line_items: [{ id: 90, quantity: 2 }] },
            { id: 701, status: "closed", line_items: [{ id: 91, quantity: 1 }] },
          ],
        },
      },
      { match: "POST fulfillments.json", body: { fulfillment: { id: 9100, status: "success" } } },
    ]);
  });

  afterAll(() => stub.close());
  beforeEach(() => {
    stub.requests.length = 0;
  });

  it("fulfils the open fulfillment orders and records what the store answered", async () => {
    const result = await makeAdapter().confirmShipment(targetFor(stub), {
      externalOrderId: "5001",
      trackingNumber: "TRK-1",
      carrierName: "Bluedart",
      trackingUrl: "https://track.example/TRK-1",
      lines: [{ sku: "SKU-A", quantity: "2.0000" }],
    });

    expect(result).toEqual({
      ok: true,
      answeredAt: expect.any(Date),
      externalFulfilmentId: "9100",
      status: "success",
    });

    const posted = stub.requests.find((request) => request.path.startsWith("fulfillments.json"));
    // The closed fulfillment order is left alone: re-fulfilling it would tell a
    // customer a second parcel is on its way.
    expect(posted?.body).toEqual({
      fulfillment: {
        line_items_by_fulfillment_order: [{ fulfillment_order_id: 700 }],
        tracking_info: { number: "TRK-1", company: "Bluedart", url: "https://track.example/TRK-1" },
        notify_customer: true,
      },
    });
  });

  it("is terminal when the order has nothing left to fulfil", async () => {
    stub.route({
      match: "GET orders/5001/fulfillment_orders.json",
      once: true,
      body: { fulfillment_orders: [{ id: 702, status: "closed", line_items: [] }] },
    });

    const result = await makeAdapter().confirmShipment(targetFor(stub), {
      externalOrderId: "5001",
      trackingNumber: null,
      carrierName: null,
      trackingUrl: null,
      lines: [{ sku: "SKU-A", quantity: "2.0000" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Waiting cannot make Shopify produce a fulfillment order for an order it
    // has already closed, so this must not walk the retry ladder.
    expect(result).toMatchObject({ code: "NO_OPEN_FULFILMENT_ORDER", terminal: true });
  });
});

describe("INV-27 — what the adapter does when the store misbehaves", () => {
  let stub: ShopifyStub;

  beforeAll(async () => {
    stub = await startShopifyStub([{ match: "GET products.json", body: PRODUCTS }]);
  });

  afterAll(() => stub.close());

  it("treats a 503 as retryable, not as a refusal", async () => {
    stub.route({ match: "GET products.json", once: true, status: 503, body: { errors: "down" } });

    const result = await makeAdapter().pushStock(targetFor(stub), [{ sku: "SKU-A", quantity: "1.0000" }]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).toMatchObject({ code: "HTTP_503", terminal: false });
  });

  it("treats a 401 as terminal, and does not quote the token back", async () => {
    stub.route({ match: "GET products.json", once: true, status: 401, body: { errors: TOKEN } });

    const result = await makeAdapter().pushStock(targetFor(stub), [{ sku: "SKU-A", quantity: "1.0000" }]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).toMatchObject({ code: "HTTP_401", terminal: true });
    // The 401 body is deliberately not read: an authentication error is the
    // response most likely to quote back what it was sent, and this message
    // reaches a dead-letter row an operator reads.
    expect(result.message).not.toContain(TOKEN);
  });

  it("treats a 200 carrying an unreadable body as retryable rather than as an answer", async () => {
    stub.route({ match: "GET inventory_levels.json", once: true, text: "<html>maintenance</html>" });

    const snapshot = await makeAdapter().fetchSnapshot({
      channelType: "SHOPIFY",
      storeUrl: stub.url,
      skus: ["SKU-A"],
    });

    expect(snapshot.ok).toBe(false);
    if (snapshot.ok) return;
    // This is the failure mode E6 names: a 200 with an error body must never
    // become "the channel says nothing", which under ALLOW_ADJUSTMENT is one
    // request away from zeroing a warehouse.
    expect(snapshot).toMatchObject({ code: "UNREADABLE_RESPONSE", terminal: false });
  });

  it("refuses to send the deployment token to a host the tenant chose", async () => {
    // The credential-exfiltration path. `storeUrl` is a tenant column, so a
    // tenant who can point a credentialled call at their own server collects the
    // deployment's Shopify token.
    const result = await makeAdapter().pushStock(
      {
        channelType: "SHOPIFY",
        storeUrl: "https://collector.example.com",
        settings: { shopifyLocationId: LOCATION },
      },
      [{ sku: "SKU-A", quantity: "1.0000" }],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).toMatchObject({ code: "NO_CREDENTIAL", terminal: true });
    expect(result.message).toContain(".myshopify.com");
  });

  it("is inert with no token, and says which variable is missing", async () => {
    const adapter = makeAdapter({ token: undefined });
    expect(adapter.isConfigured()).toBe(false);
    expect(adapter.configurationProblem()).toBe("INV_CHANNEL_SHOPIFY_ACCESS_TOKEN is not set");

    const result = await adapter.fetchOrders(targetFor(stub), null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).toMatchObject({ code: "NO_CREDENTIAL", terminal: true });
    // Names the variable, never a value: this string reaches a log line that
    // outlives the deployment.
    expect(result.message).toContain("INV_CHANNEL_SHOPIFY_ACCESS_TOKEN");
  });

  it("refuses a channel with no location id rather than guessing one", async () => {
    const result = await makeAdapter().pushStock(
      { channelType: "SHOPIFY", storeUrl: stub.url, settings: {} },
      [{ sku: "SKU-A", quantity: "1.0000" }],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Shopify inventory is per location. Picking one would push stock to a
    // building nobody chose.
    expect(result.message).toContain("shopifyLocationId");
  });
});
