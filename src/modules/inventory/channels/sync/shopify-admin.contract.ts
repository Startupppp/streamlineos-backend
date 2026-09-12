import { z } from "zod";
import type { ChannelOrder, ChannelStockOffer } from "./channel-commerce.port";

/**
 * INV-27 — the Shopify Admin REST shapes, parsed rather than trusted.
 *
 * Everything a marketplace sends is upstream input (backend/CLAUDE.md §4:
 * "Validate and sanitize upstream/third-party responses"), so each response is
 * run through a Zod schema and anything that does not parse is a *failure*
 * rather than a partially-filled object. The alternative — reading fields off an
 * untyped body — is how "the channel says 0" gets manufactured out of an error
 * page, and E6 already documents what that costs.
 *
 * Kept apart from `shopify-admin.adapter.ts` for the reason `live-irp.contract.ts`
 * is kept apart from its adapter: these are pure functions over values, so the
 * question "does this build the right request and read the right answer" can be
 * asked without a socket, and the adapter is left holding only credentials,
 * `fetch` and the failure taxonomy.
 *
 * ## Shopify's identity model, and why this file exists at all
 *
 * Our port speaks SKU, because a SKU is the only handle we and a channel both
 * hold (E6's words). Shopify's inventory endpoints speak `inventory_item_id`,
 * which is a Shopify-internal number, and the REST API has no "look up a variant
 * by SKU" route. So a push or a pull needs a SKU → inventory_item_id index,
 * built by paging the store's products. That is what a real integration does on
 * REST, and it is the single largest cost in this adapter — see
 * `SHOPIFY_PRODUCT_PAGE_LIMIT`.
 */

/**
 * Pinned, never floating. Shopify dates its API by quarter and removes versions
 * after a year; a deployment that follows "latest" gets its integration changed
 * underneath it on Shopify's schedule rather than on ours.
 */
export const SHOPIFY_DEFAULT_API_VERSION = "2024-10";

/** Shopify's own maximum page size for these collections. */
export const SHOPIFY_PAGE_SIZE = 250;

/**
 * How many product pages the SKU index will walk before giving up.
 *
 * 250 x 20 = 5,000 variants. A catalogue larger than that needs the GraphQL
 * `productVariants(query: "sku:…")` lookup instead of this index, and the
 * failure here is loud (`CATALOGUE_TOO_LARGE`, non-terminal) rather than a
 * silently truncated map that would report every unlisted SKU as unknown.
 */
export const SHOPIFY_PRODUCT_PAGE_LIMIT = 20;

/* ------------------------------------------------------------------ *
 * Response schemas
 * ------------------------------------------------------------------ */

/**
 * Shopify sends ids as JSON numbers and prices as strings. Neither is coerced
 * into the other: an id that arrives as something else is a response we do not
 * understand, and guessing is what this file exists to avoid.
 */
const shopifyId = z.number().int();

export const shopifyProductsPageSchema = z.object({
  products: z.array(
    z.object({
      id: shopifyId,
      variants: z
        .array(
          z.object({
            id: shopifyId,
            /** Nullable and often empty — a Shopify variant is not required to have one. */
            sku: z.string().nullable().optional(),
            inventory_item_id: shopifyId,
          }),
        )
        .default([]),
    }),
  ),
});

export const shopifyInventoryLevelsSchema = z.object({
  inventory_levels: z.array(
    z.object({
      inventory_item_id: shopifyId,
      location_id: shopifyId,
      /**
       * Null when the item is not stocked at that location, which is NOT zero —
       * the same distinction E6 draws between "did not mention" and "has none".
       */
      available: z.number().int().nullable(),
    }),
  ),
});

export const shopifyInventorySetSchema = z.object({
  inventory_level: z.object({
    inventory_item_id: shopifyId,
    location_id: shopifyId,
    available: z.number().int(),
  }),
});

export const shopifyOrdersSchema = z.object({
  orders: z.array(
    z.object({
      id: shopifyId,
      name: z.string(),
      created_at: z.string(),
      currency: z.string(),
      shipping_address: z
        .object({
          address1: z.string().nullable().optional(),
          address2: z.string().nullable().optional(),
          city: z.string().nullable().optional(),
          province: z.string().nullable().optional(),
          zip: z.string().nullable().optional(),
          country: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
      line_items: z.array(
        z.object({
          id: shopifyId,
          sku: z.string().nullable().optional(),
          quantity: z.number().int(),
          price: z.string(),
        }),
      ),
    }),
  ),
});

export const shopifyFulfillmentOrdersSchema = z.object({
  fulfillment_orders: z.array(
    z.object({
      id: shopifyId,
      status: z.string(),
      line_items: z.array(z.object({ id: shopifyId, quantity: z.number().int() })),
    }),
  ),
});

export const shopifyFulfillmentSchema = z.object({
  fulfillment: z.object({ id: shopifyId, status: z.string() }),
});

/** What a Shopify 4xx carries when it is willing to say. Best-effort by design. */
export const shopifyErrorsSchema = z.object({
  errors: z.union([z.string(), z.record(z.string(), z.unknown())]),
});

/* ------------------------------------------------------------------ *
 * Pure mappers
 * ------------------------------------------------------------------ */

export type ShopifyProductsPage = z.infer<typeof shopifyProductsPageSchema>;
export type ShopifyOrders = z.infer<typeof shopifyOrdersSchema>;

/** SKU → inventory_item_id, from however many product pages were walked. */
export function indexSkus(pages: readonly ShopifyProductsPage[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const page of pages) {
    for (const product of page.products) {
      for (const variant of product.variants) {
        const sku = variant.sku?.trim();
        // A variant with no SKU is not an error and is not indexable; skipping it
        // silently is correct because we only ever look up SKUs we publish.
        if (!sku) continue;
        // First wins. Shopify permits duplicate SKUs across variants, and
        // choosing the last would make which variant we push to depend on page
        // order — a difference that would move on its own between runs.
        if (!index.has(sku)) index.set(sku, variant.inventory_item_id);
      }
    }
  }
  return index;
}

/**
 * Our decimal availability as the integer Shopify will accept.
 *
 * Floored, never rounded: offering 3 when 2.6 are on the shelf is an oversell,
 * and an oversell on a marketplace is a cancelled order and a seller-performance
 * penalty. A negative figure — which `syncStock` already clamps, but which this
 * function must not depend on — becomes 0 rather than a negative offer Shopify
 * would reject outright.
 *
 * **Known limit:** a catch-weight SKU is sold by weight, so flooring its
 * availability to whole units is wrong for it in a way it is right for
 * everything else. Shopify's inventory API has no fractional availability, so
 * the resolution is not in this function — a catch-weight SKU should not be
 * published to a Shopify channel at all, which is a gate nothing enforces yet.
 */
export function toShopifyAvailable(quantity: string): number {
  const parsed = Number.parseFloat(quantity);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

/** Shopify's integer availability as the decimal string inventory speaks. */
export function fromShopifyAvailable(available: number): string {
  return `${available}.0000`;
}

export function offersBySku(
  offers: readonly ChannelStockOffer[],
): Map<string, ChannelStockOffer> {
  return new Map(offers.map((offer) => [offer.sku, offer]));
}

/**
 * Shopify's `Link: <…>; rel="next"` header, which is how its REST API paginates.
 *
 * Returns the `page_info` cursor rather than the whole URL: the URL in that
 * header is a host Shopify chose, and following it verbatim would be a redirect
 * we did not authorise. We rebuild the request against the store host we already
 * validated and carry only the opaque cursor across.
 */
export function nextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    if (!/rel="?next"?/.test(part)) continue;
    const match = /[?&]page_info=([^&>"';\s]+)/.exec(part);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

/**
 * One Shopify order in our vocabulary.
 *
 * The address is flattened to the single text line `inv_sales_orders` holds.
 * Nothing else about the customer is carried: importing a marketplace's customer
 * identity is a separate decision with its own retention duty, and an order can
 * be picked and shipped without it.
 *
 * A line with no SKU is kept rather than dropped, with an empty SKU, so that the
 * import fails loudly on it instead of quietly creating a short order. Which is
 * what `channel-sync-orders.ts` does with it.
 */
export function toChannelOrders(body: ShopifyOrders): ChannelOrder[] {
  return body.orders.map((order) => ({
    externalOrderId: String(order.id),
    externalOrderNumber: order.name,
    placedAt: new Date(order.created_at),
    currency: order.currency,
    shippingAddress: flattenAddress(order.shipping_address),
    lines: order.line_items.map((line) => ({
      sku: line.sku?.trim() ?? "",
      quantity: `${line.quantity}.0000`,
      unitPrice: line.price,
    })),
  }));
}

function flattenAddress(
  address:
    | {
        address1?: string | null;
        address2?: string | null;
        city?: string | null;
        province?: string | null;
        zip?: string | null;
        country?: string | null;
      }
    | null
    | undefined,
): string | null {
  if (!address) return null;
  const parts = [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.zip,
    address.country,
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}
