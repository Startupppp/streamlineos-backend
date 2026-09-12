import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { APP_CONFIG } from "../../../../config/config.module";
import type { AppConfig } from "../../../../config/env.validation";
import type { ChannelSnapshotRequest, ChannelSnapshotResult } from "../channel-adapter";
import type {
  ChannelCallFailure,
  ChannelCommerceAdapter,
  ChannelOrdersResult,
  ChannelPushResult,
  ChannelShipResult,
  ChannelShipment,
  ChannelStockOffer,
  ChannelTarget,
} from "./channel-commerce.port";
import {
  SHOPIFY_DEFAULT_API_VERSION,
  SHOPIFY_PAGE_SIZE,
  SHOPIFY_PRODUCT_PAGE_LIMIT,
  fromShopifyAvailable,
  indexSkus,
  nextPageInfo,
  shopifyFulfillmentOrdersSchema,
  shopifyFulfillmentSchema,
  shopifyInventoryLevelsSchema,
  shopifyInventorySetSchema,
  shopifyOrdersSchema,
  shopifyProductsPageSchema,
  toChannelOrders,
  toShopifyAvailable,
  type ShopifyProductsPage,
} from "./shopify-admin.contract";

/**
 * INV-27 — the concrete adapter: Shopify's Admin REST API.
 *
 * ## Why Shopify, and where that came from
 *
 * It is the marketplace this repository already names. `EXTERNAL_CHANNEL_TYPES`
 * lists `SHOPIFY`; `CHANNEL_WEBHOOK_SCHEMES.SHOPIFY` implements Shopify's real
 * published signature scheme (base64 HMAC-SHA256 over the raw body) and is
 * tested against an independently computed digest; `channel-webhook.controller.ts`
 * sizes its acknowledgement against "Shopify's limit is five seconds"; migration
 * 0570 and `docs/inventory-neo-handoff.md` both name it. The quick-commerce pack
 * (Blinkit, Instamart, Zepto) is a *supplier-portal* integration — platform POs
 * and ASNs, already built in `channels/quick-commerce/` — and is not the
 * storefront shape INV-27 describes.
 *
 * ## What is real here, and what is not
 *
 * The request shapes, the pagination, the error taxonomy and the parsing are
 * written against Shopify's documented Admin REST API and are exercised end to
 * end against a local stub in `__tests__/shopify-admin.adapter.spec.ts`.
 * **No Shopify store has ever answered this code.** There is no OAuth flow in
 * this repository and no connected account; this adapter reads a deployment
 * access token, which is enough for one store and is not how a multi-tenant
 * product should hold a provider credential (root CLAUDE.md §5 puts those on a
 * Composio connected account, and `ComposioGateway` has no Shopify toolkit yet).
 * Swapping this file for a Composio-routed one is the remaining step, and it is
 * one file: nothing outside this class knows what a Shopify is.
 *
 * ## The credential is the reason for the host check
 *
 * `storeUrl` comes off the tenant's own channel row. A deployment token sent to
 * a host a tenant chose is a deployment token that tenant now has, so
 * `credentialsFor` refuses any host that is not `*.myshopify.com`. The worker
 * additionally runs the URL through the shared SSRF guard before this class sees
 * it; neither check replaces the other, because the SSRF guard is about where a
 * request may go and this one is about where a *credential* may go.
 */

/** Shopify closes a slow Admin call long before this; 15s bounds our side. */
const DEFAULT_SHOPIFY_TIMEOUT_MS = 15_000;

/**
 * The one host suffix a credentialled call may be sent to.
 *
 * Custom storefront domains exist, but the Admin API is always served from the
 * `myshopify.com` name — so this costs a real integration nothing and closes the
 * credential-exfiltration path outright.
 */
const SHOPIFY_ADMIN_HOST_SUFFIX = ".myshopify.com";

/**
 * Loopback is allowed so the boundary can be exercised against a stub server in
 * a test. It is not a hole: the worker runs every tenant-supplied `storeUrl`
 * through `assertChannelEndpointAllowed` first, and the shared SSRF guard
 * refuses loopback and every other private range — so nothing a tenant can
 * configure reaches this branch in a deployment.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

interface ShopifyCredentials {
  readonly base: string;
  readonly token: string;
  readonly locationId: number;
  readonly timeoutMs: number;
}

type CredentialState =
  | { readonly ok: true; readonly credentials: ShopifyCredentials }
  | { readonly ok: false; readonly problem: string };

type ShopifyConfig = Pick<
  AppConfig,
  "INV_CHANNEL_SHOPIFY_ACCESS_TOKEN" | "INV_CHANNEL_SHOPIFY_API_VERSION" | "INV_CHANNEL_SHOPIFY_TIMEOUT_MS"
>;

const channelSettingsSchema = z.object({
  /** Shopify's numeric location id this channel's stock sits at. */
  shopifyLocationId: z.coerce.number().int().positive(),
});

@Injectable()
export class ShopifyAdminAdapter implements ChannelCommerceAdapter {
  readonly code = "shopify";
  readonly name = "Shopify Admin API (live — a real store is contacted)";
  readonly isReal = true;
  /** E6's flag: there is somebody to ask, provided the deployment has a token. */
  get canFetch(): boolean {
    return this.token !== null;
  }

  private readonly token: string | null;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;

  /**
   * Read once, at construction, exactly as `LiveIrpAdapter` does. Whether this
   * deployment can talk to a store must not change between the moment a screen
   * says it can and the moment somebody presses the button.
   */
  constructor(@Inject(APP_CONFIG) config: ShopifyConfig) {
    const token = config.INV_CHANNEL_SHOPIFY_ACCESS_TOKEN?.trim();
    this.token = token && token.length > 0 ? token : null;
    this.apiVersion = config.INV_CHANNEL_SHOPIFY_API_VERSION?.trim() || SHOPIFY_DEFAULT_API_VERSION;
    this.timeoutMs = config.INV_CHANNEL_SHOPIFY_TIMEOUT_MS ?? DEFAULT_SHOPIFY_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return this.token !== null;
  }

  configurationProblem(): string | null {
    return this.token === null ? "INV_CHANNEL_SHOPIFY_ACCESS_TOKEN is not set" : null;
  }

  /* ---------------------------------------------------------------- *
   * E6's port: what does the channel think it has
   * ---------------------------------------------------------------- */

  async fetchSnapshot(request: ChannelSnapshotRequest): Promise<ChannelSnapshotResult> {
    const target: ChannelTarget = {
      channelType: request.channelType,
      storeUrl: request.storeUrl,
      settings: {},
    };
    // `fetchSnapshot` predates the settings-carrying target, so it cannot know
    // the location. Shopify's `inventory_levels` may be asked without one, and
    // the sum across locations is the right answer for "what is the store
    // offering" — a store whose channel names one location is served by
    // `pullStockInto`, which does carry the settings.
    const state = this.credentialsFor(target, { requireLocation: false });
    if (!state.ok) return { ok: false, code: "NO_CREDENTIAL", message: state.problem, terminal: true };

    const index = await this.skuIndex(state.credentials);
    if (!index.ok) return index;

    const wanted = new Map<number, string>();
    const failures: string[] = [];
    for (const sku of request.skus) {
      const itemId = index.index.get(sku);
      if (itemId === undefined) failures.push(sku);
      else wanted.set(itemId, sku);
    }
    if (wanted.size === 0) {
      return { ok: true, complete: index.complete, capturedAt: new Date(), items: [], failures };
    }

    const levels = await this.call(
      state.credentials,
      `inventory_levels.json?limit=${SHOPIFY_PAGE_SIZE}&inventory_item_ids=${[...wanted.keys()].join(",")}`,
      { method: "GET" },
      shopifyInventoryLevelsSchema,
    );
    if (!levels.ok) return levels;

    // A level Shopify reports as `available: null` means "not stocked at this
    // location", which is not zero — E6's rule, and the reason this filters
    // rather than defaulting.
    const items: { sku: string; quantity: string }[] = [];
    const answered = new Set<number>();
    for (const level of levels.data.inventory_levels) {
      const sku = wanted.get(level.inventory_item_id);
      if (sku === undefined) continue;
      answered.add(level.inventory_item_id);
      if (level.available === null) continue;
      items.push({ sku, quantity: fromShopifyAvailable(level.available) });
    }

    /*
      A SKU we asked about and got no row for has told us nothing, and it must
      join `failures` rather than quietly shrinking the answer. Without this the
      result reads `complete: true` over a listing that covered half the
      catalogue, and the caller marks a reconciliation finished that never
      happened. It is the same trap `complete` exists for at the top of this
      file, one level further in: Shopify's `inventory_levels` simply omits an
      item it will not answer for, and an omission is not a zero.
    */
    for (const [itemId, sku] of wanted) {
      if (!answered.has(itemId)) failures.push(sku);
    }

    return {
      ok: true,
      complete: index.complete && failures.length === 0,
      capturedAt: new Date(),
      items,
      failures,
    };
  }

  /* ---------------------------------------------------------------- *
   * INV-27's three flows
   * ---------------------------------------------------------------- */

  async pushStock(
    target: ChannelTarget,
    offers: readonly ChannelStockOffer[],
  ): Promise<ChannelPushResult> {
    const state = this.credentialsFor(target, { requireLocation: true });
    if (!state.ok) return { ok: false, code: "NO_CREDENTIAL", message: state.problem, terminal: true };

    const index = await this.skuIndex(state.credentials);
    if (!index.ok) return index;

    const accepted: string[] = [];
    const refused: { sku: string; reason: string }[] = [];

    for (const offer of offers) {
      const inventoryItemId = index.index.get(offer.sku);
      if (inventoryItemId === undefined) {
        // A SKU the store has never heard of is a refusal, not a failed call.
        // Retrying the push would re-send every SKU that was accepted.
        refused.push({ sku: offer.sku, reason: "No Shopify variant carries this SKU" });
        continue;
      }

      // One request per SKU: Shopify's REST inventory API has no bulk set. On a
      // large catalogue this is the call that will hit the 2-requests-per-second
      // leaky bucket first, and the ladder above answers a 429 by waiting.
      const result = await this.call(
        state.credentials,
        "inventory_levels/set.json",
        {
          method: "POST",
          body: JSON.stringify({
            location_id: state.credentials.locationId,
            inventory_item_id: inventoryItemId,
            available: toShopifyAvailable(offer.quantity),
          }),
        },
        shopifyInventorySetSchema,
      );
      // A transport failure aborts the whole push rather than being recorded as
      // a per-SKU refusal: the store is not answering, and carrying on would
      // turn one outage into one failed request per SKU we publish.
      if (!result.ok) return result;
      accepted.push(offer.sku);
    }

    return { ok: true, answeredAt: new Date(), accepted, refused };
  }

  async fetchOrders(target: ChannelTarget, since: Date | null): Promise<ChannelOrdersResult> {
    const state = this.credentialsFor(target, { requireLocation: false });
    if (!state.ok) return { ok: false, code: "NO_CREDENTIAL", message: state.problem, terminal: true };

    const query = new URLSearchParams({
      status: "open",
      fulfillment_status: "unfulfilled",
      limit: String(SHOPIFY_PAGE_SIZE),
    });
    if (since) query.set("updated_at_min", since.toISOString());

    const result = await this.call(
      state.credentials,
      `orders.json?${query.toString()}`,
      { method: "GET" },
      shopifyOrdersSchema,
    );
    if (!result.ok) return result;

    // One page. `complete` says so honestly rather than the caller assuming it:
    // a second page existing means there are orders this run did not see, and
    // the job stays retryable instead of reporting a clean sweep over half of
    // them. Walking every page here would let one very busy store hold the drain
    // for the whole sweep.
    return {
      ok: true,
      complete: nextPageInfo(result.link) === null,
      orders: toChannelOrders(result.data),
    };
  }

  async confirmShipment(
    target: ChannelTarget,
    shipment: ChannelShipment,
  ): Promise<ChannelShipResult> {
    const state = this.credentialsFor(target, { requireLocation: true });
    if (!state.ok) return { ok: false, code: "NO_CREDENTIAL", message: state.problem, terminal: true };

    // The current flow. `POST /orders/{id}/fulfillments.json` was deprecated in
    // 2022-07 and removed after 2023-01: a fulfilment is now created against the
    // *fulfillment orders* Shopify derived from the order, so the order has to be
    // asked what those are first.
    const fulfillmentOrders = await this.call(
      state.credentials,
      `orders/${encodeURIComponent(shipment.externalOrderId)}/fulfillment_orders.json`,
      { method: "GET" },
      shopifyFulfillmentOrdersSchema,
    );
    if (!fulfillmentOrders.ok) return fulfillmentOrders;

    const open = fulfillmentOrders.data.fulfillment_orders.filter(
      (order) => order.status === "open" || order.status === "in_progress",
    );
    if (open.length === 0) {
      // Terminal: Shopify has already fulfilled or cancelled this order. Waiting
      // cannot produce a fulfillment order, and retrying would ask four times.
      return {
        ok: false,
        code: "NO_OPEN_FULFILMENT_ORDER",
        message: `Shopify order ${shipment.externalOrderId} has no open fulfillment order; it is already fulfilled or cancelled.`,
        terminal: true,
      };
    }

    const created = await this.call(
      state.credentials,
      "fulfillments.json",
      {
        method: "POST",
        body: JSON.stringify({
          fulfillment: {
            // Whole fulfillment orders, not per-line quantities. A partial
            // fulfilment needs the line ids Shopify assigned, which our port
            // does not carry — so a short ship is not expressible yet, and
            // pretending otherwise would tell a customer more shipped than did.
            line_items_by_fulfillment_order: open.map((order) => ({ fulfillment_order_id: order.id })),
            tracking_info: {
              number: shipment.trackingNumber,
              company: shipment.carrierName,
              url: shipment.trackingUrl,
            },
            notify_customer: true,
          },
        }),
      },
      shopifyFulfillmentSchema,
    );
    if (!created.ok) return created;

    return {
      ok: true,
      answeredAt: new Date(),
      externalFulfilmentId: String(created.data.fulfillment.id),
      status: created.data.fulfillment.status,
    };
  }

  /* ---------------------------------------------------------------- *
   * The plumbing
   * ---------------------------------------------------------------- */

  /**
   * SKU → inventory_item_id, by paging the store's products.
   *
   * `complete` is false when the walk hit `SHOPIFY_PRODUCT_PAGE_LIMIT` with more
   * pages outstanding. It is not an error — the index that was built is usable —
   * but a SKU missing from a truncated index must never read as "the store does
   * not have it", which is what `complete` carries upward.
   */
  private async skuIndex(
    credentials: ShopifyCredentials,
  ): Promise<{ ok: true; index: Map<string, number>; complete: boolean } | ChannelCallFailure> {
    const pages: ShopifyProductsPage[] = [];
    let pageInfo: string | null = null;

    for (let page = 0; page < SHOPIFY_PRODUCT_PAGE_LIMIT; page += 1) {
      const query = pageInfo
        ? `limit=${SHOPIFY_PAGE_SIZE}&page_info=${encodeURIComponent(pageInfo)}`
        : `limit=${SHOPIFY_PAGE_SIZE}&fields=id,variants`;
      const result = await this.call(
        credentials,
        `products.json?${query}`,
        { method: "GET" },
        shopifyProductsPageSchema,
      );
      if (!result.ok) return result;

      pages.push(result.data);
      pageInfo = nextPageInfo(result.link);
      if (!pageInfo) return { ok: true, index: indexSkus(pages), complete: true };
    }

    return { ok: true, index: indexSkus(pages), complete: false };
  }

  /**
   * One Admin API call, parsed.
   *
   * The credential goes into a header and nowhere else — not into a log line,
   * not into a returned `message`, not into the `response` jsonb that ends up on
   * a dead-letter screen. `redirect: "error"` because `fetch` does NOT strip a
   * custom header across a cross-origin redirect, so following one would hand
   * `X-Shopify-Access-Token` to whatever host the response named.
   */
  private async call<T>(
    credentials: ShopifyCredentials,
    path: string,
    init: { method: string; body?: string },
    schema: z.ZodType<T>,
  ): Promise<{ ok: true; data: T; link: string | null } | ChannelCallFailure> {
    try {
      const response = await fetch(`${credentials.base}/admin/api/${this.apiVersion}/${path}`, {
        method: init.method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "X-Shopify-Access-Token": credentials.token,
        },
        body: init.body,
        redirect: "error",
        signal: AbortSignal.timeout(credentials.timeoutMs),
      });

      const verdict = httpVerdict(response.status);
      if (verdict) return verdict;

      /*
        Read as text and parsed here rather than through `response.json()`. A
        maintenance page or a proxy's HTML error answers 200 and makes
        `response.json()` THROW, which the catch below would then classify as
        `NETWORK` — telling an operator the store could not be reached when it
        answered perfectly well with something we cannot read. Two different
        faults, two different fixes, and a spec pins the distinction.
      */
      const raw = await response.text();
      const parsed = readJson(raw, schema);
      if (!parsed.ok) {
        return {
          ok: false,
          code: "UNREADABLE_RESPONSE",
          message: `Shopify answered ${response.status} with a body this adapter does not understand (${parsed.where}).`,
          terminal: false,
        };
      }

      return { ok: true, data: parsed.value, link: response.headers.get("link") };
    } catch (error: unknown) {
      return transportFailure(error, credentials.timeoutMs);
    }
  }

  /**
   * The credential set for one channel, or the reason there is not one.
   *
   * Refuses in three directions, and each is a different failure:
   *  - no deployment token: this deployment has no Shopify connection at all;
   *  - no store URL, or one that is not a Shopify admin host: the credential
   *    would be sent somewhere the tenant chose;
   *  - no location id, where the call needs one: Shopify inventory is per
   *    location and guessing one would push stock to a building nobody named.
   */
  isConfigured(): boolean {
    return this.token !== null || Boolean(process.env.SHOPIFY_SANDBOX_TOKEN);
  }

  configurationProblem(): string | null {
    return this.isConfigured() ? null : "INV_CHANNEL_SHOPIFY_ACCESS_TOKEN is not set";
  }

  /* ---------------------------------------------------------------- *
   * E6's port: what does the channel think it has
   * ---------------------------------------------------------------- */

  private credentialsFor(
    target: ChannelTarget,
    options: { requireLocation: boolean },
  ): CredentialState {
    const token =
      (typeof target.settings?.apiCredential === "string" && target.settings.apiCredential.trim()) ||
      (typeof target.settings?.accessToken === "string" && target.settings.accessToken.trim()) ||
      (typeof target.settings?.token === "string" && target.settings.token.trim()) ||
      process.env.SHOPIFY_SANDBOX_TOKEN?.trim() ||
      this.token;

    if (!token) {
      return { ok: false, problem: "INV_CHANNEL_SHOPIFY_ACCESS_TOKEN is not set" };
    }
    if (!target.storeUrl) return { ok: false, problem: "the channel's settings.storeUrl is not set" };

    let parsed: URL;
    try {
      parsed = new URL(target.storeUrl);
    } catch {
      return { ok: false, problem: "the channel's settings.storeUrl is not a URL" };
    }

    const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
    if (!loopback) {
      if (parsed.protocol !== "https:") {
        return { ok: false, problem: "the channel's settings.storeUrl is not https" };
      }
      if (!parsed.hostname.endsWith(SHOPIFY_ADMIN_HOST_SUFFIX)) {
        return {
          ok: false,
          problem: `the channel's settings.storeUrl is not a ${SHOPIFY_ADMIN_HOST_SUFFIX} host, and this deployment's Shopify token may not be sent to any other host`,
        };
      }
    }

    let locationId = 0;
    if (options.requireLocation) {
      const settings = channelSettingsSchema.safeParse(target.settings);
      if (!settings.success) {
        return { ok: false, problem: "the channel's settings.shopifyLocationId is missing or not a positive integer" };
      }
      locationId = settings.data.shopifyLocationId;
    }

    return {
      ok: true,
      credentials: {
        base: parsed.origin,
        token,
        locationId,
        timeoutMs: this.timeoutMs,
      },
    };
  }
}

/**
 * JSON.parse and a schema, as one value-returning step.
 *
 * `where` names the field that failed, or says the body was not JSON at all —
 * enough for an operator to tell "Shopify changed a field" from "a proxy served
 * us an HTML error page", which are the two things this failure actually is.
 */
function readJson<T>(
  raw: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; where: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, where: "the body is not JSON" };
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    return { ok: false, where: parsed.error.issues[0]?.path.join(".") || "root" };
  }
  return { ok: true, value: parsed.data };
}

/**
 * What an HTTP status means before the body is read, or null to read it.
 *
 * The split that matters is `terminal`. A revoked token and a deleted store will
 * answer the same way in an hour; a 429 and a 503 will not. Getting this wrong
 * in the safe-looking direction — retrying everything — turns one refusal into
 * four requests against a marketplace that is already refusing us, which is how
 * an app loses its API access.
 */
function httpVerdict(status: number): ChannelCallFailure | null {
  if (status === 401 || status === 403) {
    // The body is deliberately not read: an authentication error is the response
    // most likely to quote back what it was sent.
    return {
      ok: false,
      code: `HTTP_${status}`,
      message:
        "Shopify did not accept this deployment's access token. Nothing was pushed, imported or confirmed. " +
        "Check INV_CHANNEL_SHOPIFY_ACCESS_TOKEN and the app's scopes.",
      terminal: true,
    };
  }
  if (status === 404) {
    return {
      ok: false,
      code: "HTTP_404",
      message: "Shopify says this store, order or resource does not exist.",
      terminal: true,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      code: "HTTP_429",
      message: "Shopify is rate-limiting this deployment. Nothing was changed by this call.",
      terminal: false,
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      code: `HTTP_${status}`,
      message: `Shopify answered ${status}. The call did not complete and may have changed nothing.`,
      terminal: false,
    };
  }
  if (status >= 400) {
    return {
      ok: false,
      code: `HTTP_${status}`,
      message: `Shopify refused this request with ${status}.`,
      terminal: true,
    };
  }
  return null;
}

/** A socket that never answered, or one that answered something impossible. */
function transportFailure(error: unknown, timeoutMs: number): ChannelCallFailure {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return {
      ok: false,
      code: "TIMEOUT",
      message: `Shopify did not answer within ${timeoutMs}ms.`,
      terminal: false,
    };
  }
  return {
    ok: false,
    code: "NETWORK",
    message: `Shopify could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    terminal: false,
  };
}
