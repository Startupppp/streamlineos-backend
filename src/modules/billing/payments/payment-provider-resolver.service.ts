import { Inject, Injectable } from "@nestjs/common";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { and, asc, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { paymentProviders } from "../../../db/schema";
import { PaymentProviderAdapterRegistry, type PaymentProviderAdapter, type PaymentProviderRuntime, type PaymentWebhookNormalization } from "./payment-provider-adapter.interface";
import { PaymentProviderSetupService } from "./payment-provider-setup.service";

export type PaymentEnvironment = "test" | "live";

export interface OrganizationPaymentProvider {
  readonly providerKey: string;
  readonly environment: PaymentEnvironment;
  isReady(): boolean;
  publicKeyId(): string | null;
  createOrder(params: {
    amount: string;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<{ providerOrderId: string; raw: unknown }>;
  verifyPaymentSignature(params: {
    orderId: string;
    paymentId: string;
    signature: string;
  }): boolean;
  verifyWebhookSignature(params: { rawBody: string; signature: string }): boolean;
  normalizeWebhook(rawBody: string): PaymentWebhookNormalization;
}

/**
 * Resolves a provider and its encrypted credentials for one organization.
 * The returned facade deliberately omits private credential fields from its API;
 * only this boundary can pass them to the provider adapter.
 */
@Injectable()
export class PaymentProviderResolver {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: PaymentProviderAdapterRegistry,
    private readonly setup: PaymentProviderSetupService,
  ) {}

  /*
    Both reads open the organisation's own transaction.

    `payment_providers` is under row-level security, and the caller that needs it
    most is a provider webhook — a public route with no ambient tenant context at
    all. Reading it bare matches nothing and the webhook 500s, which a payment
    provider retries, so a signature failure and an outage look the same from
    outside. The organisation is named in the URL; this is where it gets used.
  */
  async resolve(
    orgId: string,
    providerKey: string,
    requestedEnvironment?: PaymentEnvironment,
  ): Promise<OrganizationPaymentProvider | undefined> {
    const provider = await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx.query.paymentProviders.findFirst({
        where: and(eq(paymentProviders.orgId, orgId), eq(paymentProviders.providerKey, providerKey)),
      }),
    );
    const adapter = this.registry.get(providerKey);
    if (!provider || provider.status === "disabled" || !adapter) return undefined;

    const environment = requestedEnvironment ?? provider.environment;
    const credentials = await this.setup.getDecryptedSecret(orgId, provider.id, environment);
    return createOrganizationProvider(adapter, providerKey, environment, credentials);
  }

  /** Resolve the organisation's enabled primary provider without making callers choose a key. */
  async resolveConfigured(
    orgId: string,
    requestedEnvironment?: PaymentEnvironment,
  ): Promise<OrganizationPaymentProvider | undefined> {
    const providers = await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx.query.paymentProviders.findMany({
        where: eq(paymentProviders.orgId, orgId),
        orderBy: [desc(paymentProviders.isPrimary), asc(paymentProviders.id)],
      }),
    );

    for (const provider of providers) {
      if (provider.status === "disabled") continue;
      const resolved = await this.resolve(orgId, provider.providerKey, requestedEnvironment);
      if (resolved) return resolved;
    }
    return undefined;
  }
}

function createOrganizationProvider(
  adapter: PaymentProviderAdapter,
  providerKey: string,
  environment: PaymentEnvironment,
  credentials: unknown,
): OrganizationPaymentProvider {
  const runtime: PaymentProviderRuntime = adapter.configure(credentials);

  return {
    providerKey,
    environment,
    isReady: runtime.isReady,
    publicKeyId: runtime.publicKeyId,
    createOrder: runtime.createOrder,
    verifyPaymentSignature: runtime.verifyPaymentSignature,
    verifyWebhookSignature: runtime.verifyWebhookSignature,
    normalizeWebhook: runtime.normalizeWebhook,
  };
}
