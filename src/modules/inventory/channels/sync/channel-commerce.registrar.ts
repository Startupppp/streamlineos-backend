import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG } from "../../../../config/config.module";
import type { AppConfig } from "../../../../config/env.validation";
import { ChannelAdapterRegistry } from "../channel-adapter";
import { ChannelCommerceRegistry } from "./channel-commerce.port";
import { ShopifyAdminAdapter } from "./shopify-admin.adapter";

/**
 * INV-27 — which channel integration this deployment runs, decided once at boot.
 *
 * A provider rather than a module-level side effect, for the reason
 * `ChannelAdapterRegistrar` gives: "which adapters exist" should be a decision
 * this process made and can be read off one place, not a consequence of which
 * files happened to be imported.
 *
 * ## It registers into both registries
 *
 * The Shopify adapter satisfies E6's snapshot port as well as INV-27's commerce
 * port, so it goes into `ChannelAdapterRegistry` too. That is the point of
 * extending rather than replacing: with `INV_CHANNEL_ADAPTER=shopify` the
 * existing webhook-driven refetch drain stops resolving `MANUAL_CHANNEL_ADAPTER`
 * and starts asking a real store, with no change to that code at all.
 *
 * ## `SHOPIFY` only
 *
 * The fake registers itself for every external channel type because it answers
 * anything. A real adapter must not: registering Shopify for `WOOCOMMERCE` would
 * send a WooCommerce store's traffic through Shopify's URL shapes and read the
 * 404s as "that order does not exist".
 *
 * ## Why there is no refusal here
 *
 * The fake's registrar throws in production because a fake that registers itself
 * there is a safety failure. This one is the opposite: it is the real thing, and
 * production is where it belongs. The refusal it needs — "you said shopify and
 * gave no token" — is in `env.validation`, so it fails the deploy rather than the
 * first sync.
 */
@Injectable()
export class ChannelCommerceRegistrar implements OnModuleInit {
  private readonly logger = new Logger(ChannelCommerceRegistrar.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, "INV_CHANNEL_ADAPTER">,
    private readonly registry: ChannelAdapterRegistry,
    private readonly commerce: ChannelCommerceRegistry,
    private readonly shopify: ShopifyAdminAdapter,
  ) {}

  onModuleInit(): void {
    if (this.config.INV_CHANNEL_ADAPTER !== "shopify") {
      this.logger.log(
        "Channel commerce: none. Stock pushes, order imports and ship confirms are not sent; " +
          "a job enqueued for a channel with no adapter dead-letters with NO_ADAPTER.",
      );
      return;
    }

    this.commerce.register("SHOPIFY", this.shopify);
    this.registry.register("SHOPIFY", this.shopify);

    this.logger.log(
      `Channel commerce: ${this.shopify.name}${
        this.shopify.isConfigured() ? "" : ` — NOT CONNECTED (${this.shopify.configurationProblem() ?? "no credentials"})`
      }`,
    );
  }
}
