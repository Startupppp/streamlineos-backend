import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { paymentProviders } from "../../../db/schema";
import { PaymentProviderAdapterRegistry, type PaymentProviderAdapter } from "./payment-provider-adapter.interface";
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
    const provider = await this.db.query.paymentProviders.findFirst({
      where: and(eq(paymentProviders.orgId, orgId), eq(paymentProviders.providerKey, providerKey)),
    });
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
    const providers = await this.db.query.paymentProviders.findMany({
      where: eq(paymentProviders.orgId, orgId),
      orderBy: [desc(paymentProviders.isPrimary), asc(paymentProviders.id)],
    });

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
  credentials: { keyId: string | null; secret: string | null; webhookSecret: string | null } | null,
): OrganizationPaymentProvider {
  const keyId = credentials?.keyId ?? null;
  const keySecret = credentials?.secret ?? null;
  const webhookSecret = credentials?.webhookSecret ?? null;

  return {
    providerKey,
    environment,
    isReady: () => Boolean(keyId && keySecret),
    publicKeyId: () => keyId,
    createOrder: async (params) => {
      if (!keyId || !keySecret) throw new Error("Payment provider credentials are not configured");
      return adapter.createOrder({ ...params, keyId, keySecret });
    },
    verifyPaymentSignature: (params) => {
      if (!keySecret) return false;
      return adapter.verifyPaymentSignature({ ...params, keySecret });
    },
    verifyWebhookSignature: (params) => {
      if (!webhookSecret) return false;
      return adapter.verifyWebhookSignature({ ...params, webhookSecret });
    },
  };
}
