import {
  CHANNEL_REFETCH_MAX_ATTEMPTS,
  CHANNEL_REFETCH_SCHEDULE_MS,
  ChannelEndpointRejected,
} from "../../channel-adapter";
import { ChannelCommerceRegistry } from "../channel-commerce.port";
import { ShopifyAdminAdapter } from "../shopify-admin.adapter";
import { SHOPIFY_DEFAULT_API_VERSION } from "../shopify-admin.contract";
import type { ChannelSyncContext } from "../channel-job.store";
import { emptyOutcome, runChannelJob, type ChannelSyncDeps } from "../channel-sync.worker";
import { InMemoryChannelJobStore, type InMemoryFixture } from "./in-memory-channel-job-store";
import { startShopifyStub, type ShopifyStub } from "./shopify-stub-server";

/**
 * INV-27 — the three flows and the dead-letter box, end to end over real HTTP.
 *
 * The adapter is the real `ShopifyAdminAdapter` pointed at a `node:http` stub
 * started in this file; only the database is in memory. So a "provider 5xx
 * retries" assertion here is a genuine 503 travelling over a socket and being
 * classified, laddered and written down — not a `jest.fn()` returning the shape
 * somebody expected.
 *
 * What the in-memory store does enforce is the unique natural key and the
 * "order and stamp together" rule, which are the two database facts the
 * idempotency argument rests on. Everything else about the SQL is migration
 * 1100's business, not this file's.
 */

const TOKEN = "shpat_stub_token";
const LOCATION = 8877;
const ORG = "org-1";
const CHANNEL = 1;

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

const ORDER = {
  id: 5001,
  name: "#1001",
  created_at: "2026-09-01T09:30:00Z",
  currency: "INR",
  shipping_address: { address1: "4 Nehru Road", city: "Pune" },
  line_items: [{ id: 90, sku: "SKU-A", quantity: 2, price: "199.00" }],
};

function contextFor(stub: ShopifyStub): ChannelSyncContext {
  return {
    orgId: ORG,
    channelId: CHANNEL,
    channelType: "SHOPIFY",
    storeUrl: stub.url,
    warehouseIds: [1],
    skuToVariant: new Map([
      ["SKU-A", 11],
      ["SKU-B", 12],
    ]),
    settings: { storeUrl: stub.url, shopifyLocationId: LOCATION },
  };
}

function makeDeps(
  store: InMemoryChannelJobStore,
  options: { registered?: boolean; token?: string | undefined; blockEndpoint?: boolean } = {},
): ChannelSyncDeps {
  const commerce = new ChannelCommerceRegistry();
  if (options.registered !== false) {
    commerce.register(
      "SHOPIFY",
      new ShopifyAdminAdapter({
        INV_CHANNEL_SHOPIFY_ACCESS_TOKEN: "token" in options ? options.token : TOKEN,
        INV_CHANNEL_SHOPIFY_API_VERSION: SHOPIFY_DEFAULT_API_VERSION,
        INV_CHANNEL_SHOPIFY_TIMEOUT_MS: 2_000,
      }),
    );
  }
  return {
    store,
    commerce,
    assertEndpointAllowed: async (url: string) => {
      if (options.blockEndpoint) throw new ChannelEndpointRejected(`Channel endpoint rejected: ${url}`);
    },
  };
}

function fixtureFor(stub: ShopifyStub, overrides: Partial<InMemoryFixture> = {}): InMemoryFixture {
  return {
    context: contextFor(stub),
    offers: [
      { sku: "SKU-A", quantity: "4.0000" },
      { sku: "SKU-B", quantity: "1.0000" },
    ],
    knownSkus: ["SKU-A", "SKU-B"],
    ...overrides,
  };
}

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
          { inventory_item_id: 112, location_id: LOCATION, available: 1 },
        ],
      },
    },
    { match: "GET orders.json", body: { orders: [ORDER] } },
    {
      match: "GET orders/5001/fulfillment_orders.json",
      body: { fulfillment_orders: [{ id: 700, status: "open", line_items: [{ id: 90, quantity: 2 }] }] },
    },
    { match: "POST fulfillments.json", body: { fulfillment: { id: 9100, status: "success" } } },
  ]);
});

afterAll(() => stub.close());
beforeEach(() => {
  stub.requests.length = 0;
});

/* ------------------------------------------------------------------ *
 * 1. Stock sync
 * ------------------------------------------------------------------ */

describe("INV-27 — stock sync", () => {
  it("pushes what is published and corrects the publication rows", async () => {
    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const job = store.seed({ kind: "STOCK_PUSH" });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store), job, outcome);

    expect(outcome).toMatchObject({ succeeded: 1, retried: 0, dead: 0 });
    expect(job.status).toBe("PROCESSED");
    expect(job.response).toMatchObject({ accepted: 2, refused: [] });
    // `syncStock` writes every non-INTERNAL publication FAILED / "Provider not
    // connected". This is the moment that stops being true.
    expect(store.publications).toEqual([{ accepted: ["SKU-A", "SKU-B"], refused: [] }]);
  });

  it("pulls the channel's own figures and records the differences", async () => {
    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const job = store.seed({ kind: "STOCK_PULL" });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store), job, outcome);

    expect(job.status).toBe("PROCESSED");
    expect(store.snapshots).toHaveLength(1);
    expect(store.snapshots[0]!.items).toEqual([
      { sku: "SKU-A", quantity: "7.0000" },
      { sku: "SKU-B", quantity: "1.0000" },
    ]);
    expect(job.response).toMatchObject({ differencesRecorded: 2, skusAnswered: 2 });
  });

  it("records the part a partial pull did answer, and stays retryable", async () => {
    // The channel answered for one of the two SKUs we publish. The row it did
    // answer is a fact and is recorded; the job does NOT report a finished
    // reconciliation over a catalogue it only half covered.
    stub.route({
      match: "GET inventory_levels.json",
      once: true,
      body: { inventory_levels: [{ inventory_item_id: 111, location_id: LOCATION, available: 7 }] },
    });

    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const job = store.seed({ kind: "STOCK_PULL" });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store), job, outcome);

    expect(store.snapshots[0]!.items).toEqual([{ sku: "SKU-A", quantity: "7.0000" }]);
    expect(job.status).toBe("FAILED");
    expect(outcome).toMatchObject({ retried: 1, dead: 0 });
    expect(job.lastError).toContain("difference(s) from the part it did answer were recorded");
  });
});

/* ------------------------------------------------------------------ *
 * 2. Order import
 * ------------------------------------------------------------------ */

describe("INV-27 — order import", () => {
  it("turns each channel order into its own job, keyed on the channel's order id", async () => {
    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const pull = store.seed({ kind: "ORDER_PULL", request: { since: null } });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store), pull, outcome);

    expect(pull.status).toBe("PROCESSED");
    expect(outcome).toMatchObject({ enqueued: 1, duplicates: 0 });
    const imports = store.byKind("ORDER_IMPORT");
    expect(imports).toHaveLength(1);
    expect(imports[0]!.externalRef).toBe("5001");
  });

  it("creates one sales order, and a second pull of the same order creates none", async () => {
    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const deps = makeDeps(store);
    const outcome = emptyOutcome();

    await runChannelJob(deps, store.seed({ kind: "ORDER_PULL", externalRef: "run:1" }), outcome);
    const imported = store.byKind("ORDER_IMPORT")[0]!;
    await runChannelJob(deps, imported, outcome);

    expect(imported.status).toBe("PROCESSED");
    expect(store.salesOrders).toHaveLength(1);

    // The channel lists the order again — every marketplace does, until it is
    // fulfilled. The unique natural key absorbs it and nothing new is queued.
    const second = emptyOutcome();
    await runChannelJob(deps, store.seed({ kind: "ORDER_PULL", externalRef: "run:2" }), second);

    expect(second).toMatchObject({ enqueued: 0, duplicates: 1 });
    expect(store.byKind("ORDER_IMPORT")).toHaveLength(1);
    expect(store.salesOrders).toHaveLength(1);
  });

  it("does not import twice even when the same import job is run again", async () => {
    // The second fence. The first is the unique key, which stops a second job
    // existing; this one covers a crash between the sales-order write and the
    // status update, which leaves a PENDING job that already produced an order.
    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const deps = makeDeps(store);
    const outcome = emptyOutcome();

    await runChannelJob(deps, store.seed({ kind: "ORDER_PULL" }), outcome);
    const imported = store.byKind("ORDER_IMPORT")[0]!;
    await runChannelJob(deps, imported, outcome);

    imported.status = "PENDING";
    await runChannelJob(deps, imported, outcome);

    expect(store.salesOrders).toHaveLength(1);
    expect(imported.status).toBe("PROCESSED");
    expect(imported.response).toMatchObject({ alreadyImported: true });
  });

  it("dead-letters an order whose SKU this catalogue does not have", async () => {
    // The most useful dead letter this flow produces. Retrying it four times
    // will not create the product, so it is terminal.
    const store = new InMemoryChannelJobStore(fixtureFor(stub, { knownSkus: [] }));
    const deps = makeDeps(store);
    const outcome = emptyOutcome();

    await runChannelJob(deps, store.seed({ kind: "ORDER_PULL" }), outcome);
    const imported = store.byKind("ORDER_IMPORT")[0]!;
    await runChannelJob(deps, imported, outcome);

    expect(imported.status).toBe("DEAD");
    expect(imported.attemptCount).toBe(1);
    expect(imported.lastErrorCode).toBe("UNKNOWN_SKU");
    expect(imported.lastError).toContain("SKU-A");
    expect(store.salesOrders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Ship confirm
 * ------------------------------------------------------------------ */

describe("INV-27 — ship confirm", () => {
  const shipRequest = {
    salesOrderId: 42,
    trackingNumber: "TRK-1",
    carrierName: "Bluedart",
    trackingUrl: "https://track.example/TRK-1",
    lines: [{ sku: "SKU-A", quantity: "2.0000" }],
  };

  it("tells the channel, and records the identifier the channel answered with", async () => {
    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const job = store.seed({ kind: "SHIP_CONFIRM", externalRef: "5001", request: shipRequest });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store), job, outcome);

    expect(job.status).toBe("PROCESSED");
    // "It worked" is not a record. The fulfilment id is what an operator quotes
    // to the marketplace when a customer says they were never told.
    expect(job.response).toMatchObject({ externalFulfilmentId: "9100", status: "success" });
  });

  it("dead-letters a job whose recorded shipment cannot be read", async () => {
    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const job = store.seed({ kind: "SHIP_CONFIRM", externalRef: "5001", request: { lines: [] } });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store), job, outcome);

    expect(job.status).toBe("DEAD");
    expect(job.lastErrorCode).toBe("MALFORMED_JOB");
  });
});

/* ------------------------------------------------------------------ *
 * 4. The dead-letter box — INV-27's acceptance
 * ------------------------------------------------------------------ */

describe("INV-27 — retry and dead-letter", () => {
  it("retries a provider 5xx on the ladder, with the reason and the attempt count", async () => {
    stub.route({ match: "GET products.json", once: true, status: 503, body: { errors: "down" } });

    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const job = store.seed({ kind: "STOCK_PUSH" });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store), job, outcome);

    expect(outcome).toMatchObject({ retried: 1, dead: 0 });
    expect(job.status).toBe("FAILED");
    expect(job.attemptCount).toBe(1);
    expect(job.lastErrorCode).toBe("HTTP_503");
    expect(job.lastError).toContain("503");
    // The first rung of E6's ladder, shared rather than copied, so a channel job
    // and a channel delivery wait the same length of time.
    expect(job.nextAttemptAt.getTime() - new Date("2026-09-12T00:00:00Z").getTime()).toBe(
      CHANNEL_REFETCH_SCHEDULE_MS[0],
    );
    expect(job.deadLetteredAt).toBeNull();
  });

  it("dead-letters once the ladder runs out, and says why", async () => {
    stub.route({ match: "GET products.json", once: true, status: 503, body: { errors: "down" } });

    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const job = store.seed({ kind: "STOCK_PUSH", attemptCount: CHANNEL_REFETCH_MAX_ATTEMPTS - 1 });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store), job, outcome);

    expect(outcome).toMatchObject({ dead: 1, retried: 0 });
    expect(job.status).toBe("DEAD");
    expect(job.attemptCount).toBe(CHANNEL_REFETCH_MAX_ATTEMPTS);
    expect(job.deadLetteredAt).not.toBeNull();
    // `chk_inv_channel_jobs_dead_has_reason` refuses a DEAD row with no message;
    // this is the code side of that constraint.
    expect(job.lastError).toBeTruthy();
    expect(job.lastErrorCode).toBe("HTTP_503");
  });

  it("gives a retried dead letter exactly one attempt, and keeps the count rising", async () => {
    // What an operator sees after pressing Retry on a row that has already
    // exhausted its ladder: one more attempt, and if it fails the count goes up
    // rather than resetting to zero and hiding the standing problem.
    stub.route({ match: "GET products.json", once: true, status: 503, body: { errors: "down" } });

    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const job = store.seed({
      kind: "STOCK_PUSH",
      status: "PENDING",
      attemptCount: CHANNEL_REFETCH_MAX_ATTEMPTS,
    });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store), job, outcome);

    expect(job.status).toBe("DEAD");
    expect(job.attemptCount).toBe(CHANNEL_REFETCH_MAX_ATTEMPTS + 1);
  });

  it("dead-letters a revoked credential on the first attempt rather than retrying it", async () => {
    stub.route({ match: "GET products.json", once: true, status: 401, body: { errors: "bad token" } });

    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const job = store.seed({ kind: "STOCK_PUSH" });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store), job, outcome);

    // Retrying a revoked token turns one wrong answer into four requests to a
    // marketplace that is already refusing us.
    expect(job.status).toBe("DEAD");
    expect(job.attemptCount).toBe(1);
    expect(job.lastErrorCode).toBe("HTTP_401");
  });

  it("dead-letters when no adapter is registered for the channel type", async () => {
    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const job = store.seed({ kind: "STOCK_PUSH" });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store, { registered: false }), job, outcome);

    expect(job.status).toBe("DEAD");
    expect(job.lastErrorCode).toBe("NO_ADAPTER");
    expect(job.lastError).toContain("by hand");
  });

  it("dead-letters when the deployment has no credential, naming the variable", async () => {
    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const job = store.seed({ kind: "STOCK_PUSH" });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store, { token: undefined }), job, outcome);

    expect(job.status).toBe("DEAD");
    expect(job.lastErrorCode).toBe("NO_CREDENTIAL");
    expect(job.lastError).toContain("INV_CHANNEL_SHOPIFY_ACCESS_TOKEN");
  });

  it("runs the SSRF guard over the tenant's store URL before any adapter sees it", async () => {
    // The store URL is a tenant column. A rejected endpoint must dead-letter
    // like any other bad channel rather than throwing out of the sweep and
    // stopping every other tenant's work.
    const store = new InMemoryChannelJobStore(fixtureFor(stub));
    const job = store.seed({ kind: "STOCK_PUSH" });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store, { blockEndpoint: true }), job, outcome);

    expect(job.status).toBe("DEAD");
    expect(job.lastErrorCode).toBe("ENDPOINT_BLOCKED");
    expect(stub.requests).toEqual([]);
  });

  it("dead-letters a job whose channel has been deleted", async () => {
    const store = new InMemoryChannelJobStore(fixtureFor(stub, { context: null }));
    const job = store.seed({ kind: "ORDER_PULL" });
    const outcome = emptyOutcome();

    await runChannelJob(makeDeps(store), job, outcome);

    expect(job.status).toBe("DEAD");
    expect(job.lastErrorCode).toBe("CHANNEL_GONE");
  });
});
