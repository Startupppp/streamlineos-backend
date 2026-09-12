import { Injectable } from "@nestjs/common";
import type { ChannelAdapter } from "../channel-adapter";

/**
 * INV-27 — the three things a sales channel can be asked to do, as a contract.
 *
 * ## How this relates to `channel-adapter.ts`
 *
 * E6 built one direction: `ChannelAdapter.fetchSnapshot`, "what does the channel
 * think it has". That is one of INV-27's three flows and it is not rebuilt here.
 * `ChannelCommerceAdapter` **extends** it, so an adapter that can import orders
 * can also answer a snapshot, and one object registers into both registries —
 * E6's refetch drain keeps working unchanged and gets a real implementation
 * instead of a fake.
 *
 * ## Every outcome is a value
 *
 * Same rule as the snapshot port, for the same reason: every caller's correct
 * response to a marketplace being unreachable is identical — record it, carry
 * on, try later — and an exception invites a caller to roll back work that must
 * not be rolled back. A failure therefore carries a `code` (what to group a
 * hundred dead letters by), a `message` (what an operator reads) and `terminal`
 * (whether waiting could ever help). `terminal` is the difference between one
 * wrong answer and four.
 *
 * ## What an adapter may not do
 *
 * The same fence E6 drew, extended. An adapter never writes stock, never writes
 * a channel row, and never writes a sales order. It returns *what the channel
 * said*, and `channel-sync.worker.ts` decides what that means — which is what
 * keeps "a marketplace cannot move our ledger by itself" true by construction:
 * this file cannot reach the stock engine or the sales-order tables, because it
 * does not import them.
 */

/** A quantity is a decimal string everywhere in inventory. A float here is a defect. */
export type DecimalString = string;

/** One line of "this is what you may sell", as we compute it. */
export interface ChannelStockOffer {
  readonly sku: string;
  readonly quantity: DecimalString;
}

/**
 * Where a call is aimed.
 *
 * `storeUrl` and `settings` both come off the tenant's own channel row and are
 * therefore **untrusted**: the caller runs them through
 * `assertChannelEndpointAllowed` before an adapter sees them, and an adapter
 * that carries a deployment credential must additionally refuse a host that is
 * not its provider's (see `ShopifyAdminAdapter.credentialsFor`). A tenant who
 * can point a credentialled call at a host they control can collect the
 * credential.
 */
export interface ChannelTarget {
  readonly channelType: string;
  readonly storeUrl: string | null;
  readonly settings: Readonly<Record<string, unknown>>;
}

/** The shape every failure takes, whichever call produced it. */
export interface ChannelCallFailure {
  readonly ok: false;
  /** Machine-readable and stable — `HTTP_503`, `NO_CREDENTIAL`, `TIMEOUT`. */
  readonly code: string;
  /** What an operator reads on the dead-letter screen. Never a credential. */
  readonly message: string;
  /** A failure no number of retries will fix — a revoked token, a dead store. */
  readonly terminal: boolean;
}

/* ------------------------------------------------------------------ *
 * 1. Stock push
 * ------------------------------------------------------------------ */

/**
 * What the channel did with an availability push.
 *
 * `refused` is separate from a failed call on purpose. A marketplace that
 * accepts 40 SKUs and refuses 2 ("we have never heard of that SKU") has
 * answered, and retrying the whole push would re-send the 40 it already took.
 * The two refusals belong on the operator's screen, not in the retry ladder.
 */
export type ChannelPushResult =
  | {
      readonly ok: true;
      readonly answeredAt: Date;
      readonly accepted: readonly string[];
      readonly refused: readonly { readonly sku: string; readonly reason: string }[];
    }
  | ChannelCallFailure;

/* ------------------------------------------------------------------ *
 * 2. Order import
 * ------------------------------------------------------------------ */

export interface ChannelOrderLine {
  readonly sku: string;
  readonly quantity: DecimalString;
  /** Per unit, in the order's currency, as a decimal string. */
  readonly unitPrice: DecimalString;
}

/**
 * One order as the channel describes it.
 *
 * `externalOrderId` is the natural key — the channel's own id, not its
 * human-facing number, because the number is reused across stores and can be
 * edited. It is what `inv_channel_jobs.external_ref` carries and therefore what
 * makes a re-import a no-op.
 *
 * The customer is deliberately **not** here beyond a shipping address. Importing
 * a marketplace's customer identity is a separate decision with its own privacy
 * weight (a Party record, a retention duty), and an order can be fulfilled
 * without it. `channel-sync-orders.ts` says what it does with the address.
 */
export interface ChannelOrder {
  readonly externalOrderId: string;
  /** What the customer would quote at you — Shopify's `name`, e.g. `#1001`. */
  readonly externalOrderNumber: string;
  readonly placedAt: Date;
  readonly currency: string;
  readonly shippingAddress: string | null;
  readonly lines: readonly ChannelOrderLine[];
}

/**
 * `complete` carries the same meaning it does for a snapshot: whether the
 * adapter believes it listed everything it was asked for. A pull that stopped
 * at a page boundary is not a pull that found nothing more, and the job stays
 * retryable rather than reporting a clean run over half the orders.
 */
export type ChannelOrdersResult =
  | { readonly ok: true; readonly complete: boolean; readonly orders: readonly ChannelOrder[] }
  | ChannelCallFailure;

/* ------------------------------------------------------------------ *
 * 3. Ship confirm
 * ------------------------------------------------------------------ */

export interface ChannelShipment {
  readonly externalOrderId: string;
  readonly trackingNumber: string | null;
  readonly carrierName: string | null;
  readonly trackingUrl: string | null;
  readonly lines: readonly { readonly sku: string; readonly quantity: DecimalString }[];
}

/**
 * What the channel answered.
 *
 * `externalFulfilmentId` is required on success and is the point of the call:
 * INV-27 asks us to record what the channel answered, and "it worked" is not a
 * record. It is what an operator quotes to the marketplace's support desk, and
 * what a future reconciliation would match on.
 */
export type ChannelShipResult =
  | {
      readonly ok: true;
      readonly answeredAt: Date;
      readonly externalFulfilmentId: string;
      readonly status: string;
    }
  | ChannelCallFailure;

/* ------------------------------------------------------------------ *
 * The port
 * ------------------------------------------------------------------ */

export interface ChannelCommerceAdapter extends ChannelAdapter {
  /** Human name for logs and for an honest empty state in the UI. */
  readonly name: string;
  /**
   * Whether this adapter would really talk to a marketplace. `false` means
   * everything it returns is synthetic and must be presented as such — the same
   * flag, for the same reason, as `ComplianceTransportAdapter.isReal`.
   */
  readonly isReal: boolean;

  /**
   * Whether this deployment has been given what this adapter needs. Split from
   * `resolve` so a screen can say "not connected" without pretending to try.
   */
  isConfigured(): boolean;
  /**
   * Why not, in variable names. **Never a value** — this string reaches a boot
   * error, a log line and a dead-letter row, and a secret that reaches any of
   * those is leaked for as long as they are kept.
   */
  configurationProblem(): string | null;

  pushStock(target: ChannelTarget, offers: readonly ChannelStockOffer[]): Promise<ChannelPushResult>;
  fetchOrders(target: ChannelTarget, since: Date | null): Promise<ChannelOrdersResult>;
  confirmShipment(target: ChannelTarget, shipment: ChannelShipment): Promise<ChannelShipResult>;
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

/**
 * Which commerce adapter speaks for a channel type, if any.
 *
 * A **separate map** from `ChannelAdapterRegistry` rather than a narrowing cast
 * over it. `ChannelAdapterRegistry` holds the snapshot port and its fallback is
 * `MANUAL_CHANNEL_ADAPTER`, which is a real answer — "this organisation
 * reconciles by hand". There is no equivalent fallback for pushing stock or
 * confirming a shipment: the honest answer is `null`, and a caller has to handle
 * it. Two maps make that a compile-time fact rather than a runtime type guard
 * over a structural union.
 *
 * Registration is always a deliberate act by this process at boot. Nothing here
 * is keyed on a value a tenant typed.
 */
@Injectable()
export class ChannelCommerceRegistry {
  private readonly adapters = new Map<string, ChannelCommerceAdapter>();

  register(channelType: string, adapter: ChannelCommerceAdapter): void {
    this.adapters.set(channelType.trim().toUpperCase(), adapter);
  }

  resolve(channelType: string | null | undefined): ChannelCommerceAdapter | null {
    if (!channelType) return null;
    return this.adapters.get(channelType.trim().toUpperCase()) ?? null;
  }

  /**
   * What a screen should say about a channel's connection. Separated from
   * `resolve` so the honest empty state does not have to know what an adapter is.
   */
  describe(channelType: string | null | undefined): {
    readonly connected: boolean;
    readonly real: boolean;
    readonly name: string;
    readonly problem: string | null;
  } {
    const adapter = this.resolve(channelType);
    if (!adapter) {
      return {
        connected: false,
        real: false,
        name: "No channel integration is configured. Stock, orders and shipments are handled by hand.",
        problem: null,
      };
    }
    return {
      connected: adapter.isConfigured(),
      real: adapter.isReal,
      name: adapter.name,
      problem: adapter.configurationProblem(),
    };
  }
}
