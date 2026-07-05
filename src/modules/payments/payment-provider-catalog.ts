export interface PaymentProviderCatalogEntry {
  key: string;
  displayName: string;
  supportedCountries: string[];
  supportedCurrencies: string[];
  supportedPaymentMethods: string[];
  useCases: string[];
  credentialFields: string[];
  /** True once a real backend adapter (order creation, signature/webhook verification) exists. */
  isImplemented: boolean;
  /** Event names the webhook endpoint should subscribe to (12_...md "Required events"). */
  expectedWebhookEvents: string[];
}

// Initial providers per 12_Payment_Integration_Setup_Page.md. Stripe and future providers
// (PayPal, Paddle, Chargebee, Cashfree, PayU) are listed as not-yet-implemented so the catalog
// endpoint and provider cards can show them without a working adapter behind them.
export const PAYMENT_PROVIDER_CATALOG: PaymentProviderCatalogEntry[] = [
  {
    key: "razorpay",
    displayName: "Razorpay",
    supportedCountries: ["IN"],
    supportedCurrencies: ["INR"],
    supportedPaymentMethods: ["card", "upi", "netbanking", "wallet"],
    useCases: ["subscriptions", "invoices", "checkout", "payment_links", "refunds", "upi"],
    credentialFields: ["keyId", "keySecret", "webhookSecret"],
    isImplemented: true,
    expectedWebhookEvents: [
      "payment.authorized",
      "payment.captured",
      "payment.failed",
      "refund.created",
      "refund.processed",
      "subscription.charged",
      "subscription.cancelled",
    ],
  },
  {
    key: "stripe",
    displayName: "Stripe",
    supportedCountries: ["US", "GB", "CA", "AU", "IN", "SG", "EU"],
    supportedCurrencies: ["USD", "EUR", "GBP", "AUD", "CAD"],
    supportedPaymentMethods: ["card"],
    useCases: ["subscriptions", "invoices", "checkout", "refunds"],
    credentialFields: ["publishableKey", "secretKey", "webhookSecret"],
    isImplemented: false,
    expectedWebhookEvents: [
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
      "charge.refunded",
      "invoice.paid",
      "customer.subscription.deleted",
    ],
  },
  {
    key: "manual",
    displayName: "Manual / Bank Transfer",
    supportedCountries: ["*"],
    supportedCurrencies: ["*"],
    supportedPaymentMethods: ["bank_transfer", "upi", "cheque", "cash"],
    useCases: ["invoices", "bank_transfer", "offline_recording"],
    credentialFields: [],
    isImplemented: true,
    expectedWebhookEvents: [],
  },
];

export function getCatalogEntry(providerKey: string): PaymentProviderCatalogEntry | undefined {
  return PAYMENT_PROVIDER_CATALOG.find((p) => p.key === providerKey);
}
