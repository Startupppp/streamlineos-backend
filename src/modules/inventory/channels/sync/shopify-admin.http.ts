import { z } from "zod";
import {
  SHOPIFY_PAGE_SIZE,
  SHOPIFY_PRODUCT_PAGE_LIMIT,
  indexSkus,
  nextPageInfo,
  shopifyProductsPageSchema,
  type ShopifyProductsPage,
} from "./shopify-admin.contract";
import type { ChannelCallFailure, ChannelTarget } from "./channel-commerce.port";
import { decryptSecret } from "../../../../common/security/secret-encryption.util";

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

const channelSettingsSchema = z.object({
  /** Shopify's numeric location id this channel's stock sits at. */
  shopifyLocationId: z.coerce.number().int().positive(),
});

export interface ShopifyCredentials {
  readonly base: string;
  readonly token: string;
  readonly apiVersion: string;
  readonly locationId: number;
  readonly timeoutMs: number;
}

export type CredentialState =
  | { readonly ok: true; readonly credentials: ShopifyCredentials }
  | { readonly ok: false; readonly problem: string };

function orgCredential(target: ChannelTarget): string | null | undefined {
  const plain = target.settings?.apiCredential;
  if (typeof plain === "string" && plain.trim() !== "") return plain.trim();
  const encrypted = target.settings?.apiCredentialEncrypted;
  if (typeof encrypted !== "string" || encrypted.trim() === "") return null;
  try {
    const decrypted = decryptSecret(encrypted.trim()).trim();
    return decrypted === "" ? undefined : decrypted;
  } catch {
    return undefined;
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
export function credentialsFor(
  token: string | null,
  apiVersion: string,
  timeoutMs: number,
  target: ChannelTarget,
  options: { requireLocation: boolean },
): CredentialState {
  const orgToken = orgCredential(target);
  if (orgToken === undefined)
    return { ok: false, problem: "the channel's stored Shopify credential could not be decrypted" };
  const effectiveToken = orgToken ?? token;
  if (effectiveToken === null) return { ok: false, problem: "INV_CHANNEL_SHOPIFY_ACCESS_TOKEN is not set" };
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
      token: effectiveToken,
      apiVersion,
      locationId,
      timeoutMs,
    },
  };
}

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

function httpVerdict(status: number): ChannelCallFailure | null {
  if (status === 401 || status === 403) {
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

/**
 * One Admin API call, parsed.
 *
 * The credential goes into a header and nowhere else — not into a log line,
 * not into a returned `message`, not into the `response` jsonb that ends up on
 * a dead-letter screen. `redirect: "error"` because `fetch` does NOT strip a
 * custom header across a cross-origin redirect, so following one would hand
 * `X-Shopify-Access-Token` to whatever host the response named.
 */
export async function call<T>(
  credentials: ShopifyCredentials,
  path: string,
  init: { method: string; body?: string },
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T; link: string | null } | ChannelCallFailure> {
  try {
    const response = await fetch(`${credentials.base}/admin/api/${credentials.apiVersion}/${path}`, {
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
 * SKU → inventory_item_id, by paging the store's products.
 *
 * `complete` is false when the walk hit `SHOPIFY_PRODUCT_PAGE_LIMIT` with more
 * pages outstanding. It is not an error — the index that was built is usable —
 * but a SKU missing from a truncated index must never read as "the store does
 * not have it", which is what `complete` carries upward.
 */
export async function skuIndex(
  credentials: ShopifyCredentials,
): Promise<{ ok: true; index: Map<string, number>; complete: boolean } | ChannelCallFailure> {
  const pages: ShopifyProductsPage[] = [];
  let pageInfo: string | null = null;

  for (let page = 0; page < SHOPIFY_PRODUCT_PAGE_LIMIT; page += 1) {
    const query = pageInfo
      ? `limit=${SHOPIFY_PAGE_SIZE}&page_info=${encodeURIComponent(pageInfo)}`
      : `limit=${SHOPIFY_PAGE_SIZE}&fields=id,variants`;
    const result = await call(
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
