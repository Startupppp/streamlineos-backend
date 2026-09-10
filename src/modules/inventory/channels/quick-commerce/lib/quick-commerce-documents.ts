import {
  invAsnLines,
  invAsns,
  invPlatformPoLines,
  invPlatformPurchaseOrders,
} from "../../../../../db/schema";

/**
 * The two document shapes the NEO-2 flows hand back.
 *
 * Spelled out here rather than inferred from `loadPlatformPo`/`loadAsn` because
 * those two reads stay PRIVATE on the service — they are the ones that can be
 * called without a warehouse gate — and a flow in `lib/` receives the reload as
 * a bound callback rather than importing the read. A callback needs a return
 * type, and this is it.
 */
export type PlatformPoDetail = typeof invPlatformPurchaseOrders.$inferSelect & {
  readonly lines: (typeof invPlatformPoLines.$inferSelect)[];
};

export type AsnDetail = typeof invAsns.$inferSelect & {
  readonly lines: (typeof invAsnLines.$inferSelect)[];
};
