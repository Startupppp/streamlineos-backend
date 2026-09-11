import { Injectable } from "@nestjs/common";
import { PaymentRequiredException } from "../../../common/http/api-exceptions";
import type { PlatformPaymentProvider } from "./platform-payment-provider";
import { RazorpayService } from "./razorpay.service";
import { StripeService } from "./stripe.service";
import { selectProvider, type ProviderKey } from "./provider-selection";

export interface ResolvedProvider {
  readonly provider: PlatformPaymentProvider;
  /**
   * False when the currency's preferred provider was unavailable.
   *
   * Surfaced rather than swallowed: the customer's statement will show a
   * conversion, and somebody has to be able to warn them.
   */
  readonly isPreferred: boolean;
}

/**
 * The single place that knows which provider is which.
 *
 * Ticket 01 extracted `PlatformPaymentProvider` so that a second implementation
 * would not put a `provider === "razorpay"` branch at every call site. This is
 * what keeps that promise: callers ask for a currency and get something
 * satisfying the interface, and neither provider's vocabulary reaches them.
 *
 * A class rather than a factory function because both providers are Nest
 * singletons holding configuration, and resolving them per call is what makes
 * "is Stripe configured" a live question rather than one answered at boot -- a
 * deployment can be given credentials and restarted into service without any
 * other module knowing that happened.
 */
@Injectable()
export class PlatformPaymentRegistry {
  private readonly byKey: Readonly<Record<ProviderKey, PlatformPaymentProvider>>;

  constructor(razorpay: RazorpayService, stripe: StripeService) {
    this.byKey = { razorpay, stripe };
  }

  /** Every provider that could take a payment right now. */
  available() {
    return {
      razorpay: this.byKey.razorpay.isConfigured(),
      stripe: this.byKey.stripe.isConfigured(),
    };
  }

  /**
   * The provider for a currency.
   *
   * Throws `PaymentRequiredException` rather than returning null when nothing
   * can charge: a caller reaching here has a customer trying to pay, and there
   * is no sensible partial answer -- the alternative is every call site writing
   * the same refusal.
   */
  forCurrency(currency: string): ResolvedProvider {
    const selection = selectProvider(currency, this.available());

    if (!selection.ok) {
      throw new PaymentRequiredException({
        code: "NO_PAYMENT_PROVIDER",
        message: selection.reason,
        details: { currency },
      });
    }

    return {
      provider: this.byKey[selection.provider],
      isPreferred: selection.isPreferred,
    };
  }

  /**
   * A provider by the key stored on an existing charge.
   *
   * Ticket 02's expand put `provider` on the payment rows precisely so a refund
   * or a webhook years later goes back to the system that took the money, rather
   * than to whichever provider today's currency rule would pick.
   */
  byProviderKey(key: string): PlatformPaymentProvider | null {
    return key === "razorpay" || key === "stripe" ? this.byKey[key] : null;
  }
}
