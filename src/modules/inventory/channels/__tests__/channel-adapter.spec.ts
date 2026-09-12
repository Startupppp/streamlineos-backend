import { createHmac } from "node:crypto";
import {
  CHANNEL_REFETCH_MAX_ATTEMPTS,
  CHANNEL_REFETCH_SCHEDULE_MS,
  CHANNEL_WEBHOOK_SCHEMES,
  ChannelAdapterRegistry,
  ChannelEndpointRejected,
  ChannelTimeoutError,
  MANUAL_CHANNEL_ADAPTER,
  assertChannelEndpointAllowed,
  nextChannelAttemptDelayMs,
  planChannelAttempt,
  signChannelPayload,
  verifyChannelDelivery,
  withChannelTimeout,
  type ChannelAdapter,
} from "../channel-adapter";

/**
 * E6 — the channel boundary, exercised against fakes.
 *
 * There is no Shopify store, so nothing here proves we can talk to one. What it
 * does prove is that the half of the boundary that does not need a store — the
 * signature scheme, the retry ladder, the deadline, and the SSRF gate on a
 * tenant-supplied endpoint — behaves the way the failure modes demand.
 */

const SECRET = "shhh-this-is-the-app-secret";
const BODY = '{"inventory_item_id":123,"available":7,"sku":"SKU-1"}';

function shopifyHeaders(overrides: Record<string, string | undefined> = {}) {
  return {
    "x-shopify-hmac-sha256": signChannelPayload(SECRET, BODY),
    "x-shopify-webhook-id": "d-1",
    "x-shopify-topic": "inventory_levels/update",
    ...overrides,
  };
}

describe("E6 — verifying an inbound channel delivery", () => {
  it("accepts a Shopify delivery signed the way Shopify signs one", () => {
    // Asserted against an independently computed digest rather than against our
    // own helper, so a bug in `signChannelPayload` cannot make this pass by
    // agreeing with itself. Base64 HMAC-SHA256 over the raw body is Shopify's
    // published scheme and WooCommerce's.
    const independent = createHmac("sha256", SECRET).update(BODY, "utf8").digest("base64");

    const result = verifyChannelDelivery({
      channelType: "SHOPIFY",
      secret: SECRET,
      rawBody: BODY,
      headers: shopifyHeaders({ "x-shopify-hmac-sha256": independent }),
    });

    expect(result).toEqual({ valid: true, deliveryId: "d-1", topic: "inventory_levels/update" });
  });

  it("accepts a WooCommerce delivery on WooCommerce's header names", () => {
    const result = verifyChannelDelivery({
      channelType: "WOOCOMMERCE",
      secret: SECRET,
      rawBody: BODY,
      headers: {
        "x-wc-webhook-signature": signChannelPayload(SECRET, BODY),
        "x-wc-webhook-delivery-id": "wc-9",
        "x-wc-webhook-topic": "product.updated",
      },
    });

    expect(result).toEqual({ valid: true, deliveryId: "wc-9", topic: "product.updated" });
  });

  it("rejects a body that changed by one byte", () => {
    const result = verifyChannelDelivery({
      channelType: "SHOPIFY",
      secret: SECRET,
      rawBody: BODY.replace('"available":7', '"available":8'),
      headers: shopifyHeaders(),
    });

    expect(result).toEqual({ valid: false, reason: "signature-mismatch" });
  });

  it("rejects a delivery signed with a different secret", () => {
    const result = verifyChannelDelivery({
      channelType: "SHOPIFY",
      secret: SECRET,
      rawBody: BODY,
      headers: shopifyHeaders({ "x-shopify-hmac-sha256": signChannelPayload("wrong", BODY) }),
    });

    expect(result).toEqual({ valid: false, reason: "signature-mismatch" });
  });

  it("refuses every delivery when no secret is configured", () => {
    // The failure this pins: an unconfigured secret must not read as "skip
    // verification". A boundary that quietly accepts unsigned traffic when its
    // secret is missing is worse than one that refuses, because it looks like it
    // is working — and it would accept anything anybody posted at it.
    const result = verifyChannelDelivery({
      channelType: "SHOPIFY",
      secret: undefined,
      rawBody: BODY,
      headers: shopifyHeaders(),
    });

    expect(result).toEqual({ valid: false, reason: "no-secret-configured" });
  });

  it("refuses a delivery that carries no delivery id", () => {
    // Without one there is nothing to deduplicate on, so the same event could
    // drive a refetch forever. Refused rather than substituted with a body
    // digest: two genuinely distinct events can carry identical bodies.
    const result = verifyChannelDelivery({
      channelType: "SHOPIFY",
      secret: SECRET,
      rawBody: BODY,
      headers: shopifyHeaders({ "x-shopify-webhook-id": undefined }),
    });

    expect(result).toEqual({ valid: false, reason: "missing-delivery-id" });
  });

  it("refuses a channel type it has no scheme for", () => {
    expect(
      verifyChannelDelivery({
        channelType: "INTERNAL",
        secret: SECRET,
        rawBody: BODY,
        headers: shopifyHeaders(),
      }),
    ).toEqual({ valid: false, reason: "unknown-channel-type" });
  });

  it("does not compare a truncated signature as a prefix match", () => {
    // `timingSafeEqual` throws on a length mismatch and a base64 SHA-256 length
    // is public, so the length is compared first. Without that guard this input
    // crashes the handler instead of rejecting.
    const full = signChannelPayload(SECRET, BODY);
    expect(
      verifyChannelDelivery({
        channelType: "SHOPIFY",
        secret: SECRET,
        rawBody: BODY,
        headers: shopifyHeaders({ "x-shopify-hmac-sha256": full.slice(0, 10) }),
      }),
    ).toEqual({ valid: false, reason: "signature-mismatch" });
  });

  it("names a distinct header set per channel type", () => {
    // Guards the drift that would silently break one channel: Shopify and
    // WooCommerce share an algorithm and differ only in header names, so a
    // copy-paste that leaves Woo reading Shopify's header verifies nothing and
    // rejects everything.
    expect(CHANNEL_WEBHOOK_SCHEMES.SHOPIFY.signatureHeader).toBe("x-shopify-hmac-sha256");
    expect(CHANNEL_WEBHOOK_SCHEMES.WOOCOMMERCE.signatureHeader).toBe("x-wc-webhook-signature");
    expect(CHANNEL_WEBHOOK_SCHEMES.SHOPIFY.deliveryIdHeader).not.toBe(
      CHANNEL_WEBHOOK_SCHEMES.WOOCOMMERCE.deliveryIdHeader,
    );
  });
});

describe("E6 — the refetch attempt ladder", () => {
  it("walks the schedule in order and stops when it runs out", () => {
    const delays: Array<number | null> = [];
    let attempts = 0;
    for (let i = 0; i < CHANNEL_REFETCH_MAX_ATTEMPTS + 1; i += 1) {
      const plan = planChannelAttempt({ attempts, ok: false });
      delays.push(plan.retryInMs);
      attempts = plan.attempts;
    }

    expect(delays.slice(0, CHANNEL_REFETCH_SCHEDULE_MS.length)).toEqual([
      ...CHANNEL_REFETCH_SCHEDULE_MS,
    ]);
    expect(delays[CHANNEL_REFETCH_SCHEDULE_MS.length]).toBeNull();
  });

  it("dead-letters once the schedule is exhausted", () => {
    const plan = planChannelAttempt({ attempts: CHANNEL_REFETCH_MAX_ATTEMPTS - 1, ok: false });
    expect(plan.deadLettered).toBe(true);
    expect(plan.attempts).toBe(CHANNEL_REFETCH_MAX_ATTEMPTS);
  });

  it("dead-letters a terminal failure on its first attempt", () => {
    // A revoked grant will not be fixed by waiting. Retrying it turns one wrong
    // answer into four, each one a request to a marketplace already refusing us.
    const plan = planChannelAttempt({ attempts: 0, ok: false, terminal: true });
    expect(plan).toEqual({ attempts: 1, retryInMs: null, deadLettered: true });
  });

  it("schedules nothing after a success", () => {
    expect(planChannelAttempt({ attempts: 2, ok: true })).toEqual({
      attempts: 3,
      retryInMs: null,
      deadLettered: false,
    });
  });

  it("returns no delay past the end of the schedule", () => {
    expect(nextChannelAttemptDelayMs(CHANNEL_REFETCH_SCHEDULE_MS.length + 1)).toBeNull();
  });
});

describe("E6 — the per-attempt deadline", () => {
  it("gives up on a channel that never answers", async () => {
    // The failure mode: a marketplace that accepts the connection and then holds
    // it. Unbounded, that socket owns a worker slot for as long as they feel
    // like it. Driven by an injected timer rather than a real clock — racing a
    // real one is how a suite starts failing on a loaded machine and nowhere
    // else.
    const neverAnswers = () => new Promise<string>(() => undefined);
    const immediateDeadline = () => Promise.resolve();

    await expect(withChannelTimeout(neverAnswers, 15_000, immediateDeadline)).rejects.toBeInstanceOf(
      ChannelTimeoutError,
    );
  });

  it("returns the value when the channel answers inside the deadline", async () => {
    const answered = await withChannelTimeout(
      () => Promise.resolve("ok"),
      15_000,
      () => new Promise<void>(() => undefined),
    );
    expect(answered).toBe("ok");
  });

  it("does not leave a late rejection unhandled after a timeout", async () => {
    // A promise that rejects after the race is lost would otherwise surface as
    // an unhandled rejection and kill the process minutes after the sweep that
    // owned it finished.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const lateFailure = () =>
      new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error("late")), 5));

    await expect(
      withChannelTimeout(lateFailure, 1, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(ChannelTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 25));

    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });
});

describe("E6 — the tenant-supplied store endpoint is an SSRF surface", () => {
  it("refuses loopback", async () => {
    await expect(assertChannelEndpointAllowed("http://127.0.0.1/admin")).rejects.toBeInstanceOf(
      ChannelEndpointRejected,
    );
  });

  it("refuses the cloud metadata endpoint", async () => {
    await expect(
      assertChannelEndpointAllowed("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toBeInstanceOf(ChannelEndpointRejected);
  });

  it("refuses the packed IPv4-mapped form new URL() actually produces", async () => {
    // `new URL("http://[::ffff:127.0.0.1]/")` normalises its host to
    // `::ffff:7f00:1`. A guard written fresh here would check the readable
    // spelling and miss this one, which is exactly why this delegates to
    // `common/security/ssrf-guard.ts` instead of re-deriving the check. If this
    // test ever fails, somebody has written a second guard.
    expect(new URL("http://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
    await expect(
      assertChannelEndpointAllowed("http://[::ffff:127.0.0.1]/admin"),
    ).rejects.toBeInstanceOf(ChannelEndpointRejected);
  });

  it("refuses a non-http scheme", async () => {
    await expect(assertChannelEndpointAllowed("file:///etc/passwd")).rejects.toBeInstanceOf(
      ChannelEndpointRejected,
    );
  });
});

describe("E6 — adapter resolution", () => {
  it("hands an unregistered channel type the manual adapter rather than throwing", () => {
    // An organisation adding a channel we have no adapter for should get manual
    // reconciliation, not a 500.
    const registry = new ChannelAdapterRegistry();
    expect(registry.forChannelType("SHOPIFY")).toBe(MANUAL_CHANNEL_ADAPTER);
    expect(registry.forChannelType(null)).toBe(MANUAL_CHANNEL_ADAPTER);
  });

  it("resolves a registered adapter case-insensitively", () => {
    const registry = new ChannelAdapterRegistry();
    const adapter: ChannelAdapter = {
      code: "test",
      canFetch: true,
      fetchSnapshot: () =>
        Promise.resolve({ ok: true, complete: true, capturedAt: new Date(), items: [], failures: [] }),
    };
    registry.register("shopify", adapter);
    expect(registry.forChannelType("SHOPIFY")).toBe(adapter);
  });

  it("reports the manual adapter as unable to fetch, and never as an empty channel", async () => {
    // `complete: false` is the load-bearing part. A manual channel has told us
    // nothing, and if it reported `complete: true` with no items every published
    // SKU would acquire a "channel says 0" difference.
    expect(MANUAL_CHANNEL_ADAPTER.canFetch).toBe(false);
    const result = await MANUAL_CHANNEL_ADAPTER.fetchSnapshot({
      channelType: "SHOPIFY",
      storeUrl: null,
      skus: ["SKU-1"],
    });
    expect(result).toMatchObject({ ok: true, complete: false, items: [] });
  });
});
