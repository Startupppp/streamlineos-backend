import { Injectable, Inject, Optional } from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";
import { createOrganizationProvider, type OrganizationPaymentProvider } from "./payment-provider-resolver.service";

export type PlatformMerchantEnvironment = "test" | "live";

export type PlatformMerchantUnavailableReason =
  | "no_credentials"
  | "incomplete_credentials"
  | "unsupported_provider";

export interface PlatformMerchantReadiness {
  readonly configured: boolean;
  readonly providerKey: string | null;
  readonly environment: PlatformMerchantEnvironment | null;
  readonly publicKeyId: string | null;
  readonly webhookConfigured: boolean;
  readonly unavailableReason: PlatformMerchantUnavailableReason | null;
}

type PlatformConfig = Pick<AppConfig, "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET" | "RAZORPAY_WEBHOOK_SECRET">;

@Injectable()
export class PlatformMerchantService {
  readonly providerKey = "razorpay";

  constructor(
    private readonly registry: PaymentProviderAdapterRegistry,
    @Optional() @Inject(APP_CONFIG) private readonly config: PlatformConfig | undefined,
  ) {}

  resolve(): OrganizationPaymentProvider | undefined {
    const adapter = this.registry.get(this.providerKey);
    if (!adapter) return undefined;
    const keyId = this.config?.RAZORPAY_KEY_ID ?? null;
    const secret = this.config?.RAZORPAY_KEY_SECRET ?? null;
    if (!keyId || !secret) return undefined;
    const env = this.environment();
    if (!env) return undefined;
    const webhookSecret = this.config?.RAZORPAY_WEBHOOK_SECRET ?? null;
    return createOrganizationProvider(adapter, this.providerKey, env, { keyId, secret, webhookSecret });
  }

  readiness(): PlatformMerchantReadiness {
    const keyId = this.config?.RAZORPAY_KEY_ID ?? null;
    const secret = this.config?.RAZORPAY_KEY_SECRET ?? null;
    const webhookSecret = this.config?.RAZORPAY_WEBHOOK_SECRET ?? null;
    const webhookConfigured = webhookSecret !== null;

    const adapter = this.registry.get(this.providerKey);
    if (!adapter) {
      return {
        configured: false,
        providerKey: this.providerKey,
        environment: null,
        publicKeyId: keyId,
        webhookConfigured,
        unavailableReason: "unsupported_provider",
      };
    }

    const hasKeyId = keyId !== null;
    const hasSecret = secret !== null;

    if (!hasKeyId && !hasSecret) {
      return {
        configured: false,
        providerKey: this.providerKey,
        environment: null,
        publicKeyId: null,
        webhookConfigured,
        unavailableReason: "no_credentials",
      };
    }

    if (!hasKeyId || !hasSecret) {
      return {
        configured: false,
        providerKey: this.providerKey,
        environment: this.environment(),
        publicKeyId: keyId,
        webhookConfigured,
        unavailableReason: "incomplete_credentials",
      };
    }

    const resolved = this.resolve();
    if (!resolved || !resolved.isReady()) {
      return {
        configured: false,
        providerKey: this.providerKey,
        environment: this.environment(),
        publicKeyId: keyId,
        webhookConfigured,
        unavailableReason: "incomplete_credentials",
      };
    }

    return {
      configured: true,
      providerKey: this.providerKey,
      environment: this.environment(),
      publicKeyId: keyId,
      webhookConfigured,
      unavailableReason: null,
    };
  }

  environment(): PlatformMerchantEnvironment | null {
    const keyId = this.config?.RAZORPAY_KEY_ID ?? null;
    if (!keyId) return null;
    if (keyId.startsWith("rzp_test_")) return "test";
    if (keyId.startsWith("rzp_live_")) return "live";
    return null;
  }
}
