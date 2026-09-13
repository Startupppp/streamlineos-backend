import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { paymentProviders } from "../../../db/schema";
import { runInNewTenantTransaction, runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { PaymentProviderAdapterRegistry, type PaymentProviderAdapter, type PaymentProviderRuntime, type PaymentWebhookNormalization, type ProviderPaymentSnapshot } from "./payment-provider-adapter.interface";
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
  fetchPayment(paymentId: string): Promise<ProviderPaymentSnapshot | null>;
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
    if (!provider || provider.status === "disabled") return undefined;
    return this.buildFromRow(provider, requestedEnvironment);
  }

  /** Resolve the organisation's enabled primary provider without making callers choose a key. */
  async resolveConfigured(
    orgId: string,
    requestedEnvironment?: PaymentEnvironment,
  ): Promise<OrganizationPaymentProvider | undefined> {
    const providers = await runInTenantTransaction(
      this.db,
      (tx) =>
        tx.query.paymentProviders.findMany({
          where: eq(paymentProviders.orgId, orgId),
          orderBy: [desc(paymentProviders.isPrimary), asc(paymentProviders.id)],
        }),
      { orgId },
    );

    for (const provider of providers) {
      if (provider.status === "disabled") continue;
      const built = await this.buildFromRow(provider, requestedEnvironment);
      if (built && built.isReady()) return built;
    }
    return undefined;
  }

  private async buildFromRow(
    row: { id: number; orgId: string; providerKey: string; environment: PaymentEnvironment },
    requestedEnvironment?: PaymentEnvironment,
  ): Promise<OrganizationPaymentProvider | undefined> {
    const adapter = this.registry.get(row.providerKey);
    if (!adapter) return undefined;
    const environment = requestedEnvironment ?? row.environment;
    const credentials = await this.setup.getDecryptedSecret(row.orgId, row.id, environment);
    return createOrganizationProvider(adapter, row.providerKey, environment, credentials);
  }
}

export function createOrganizationProvider(
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
    fetchPayment: runtime.fetchPayment,
  };
}
