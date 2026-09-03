import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  paymentProviderAccounts,
  paymentProviderCredentials,
  paymentProviders,
  paymentTestTransactions,
  paymentWebhookEndpoints,
} from "../../../db/schema";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";
import { PaymentAuditService } from "./payment-audit.service";
import { PaymentAnalyticsService } from "./payment-analytics.service";
import type { RequestActorContext } from "../../../common/audit/actor-context";

export interface ReadinessResult {
  completedChecks: string[];
  blockers: string[];
  warnings: string[];
  readyForLive: boolean;
}

@Injectable()
export class PaymentReadinessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: PaymentProviderAdapterRegistry,
    private readonly audit: PaymentAuditService,
    private readonly paymentAnalytics: PaymentAnalyticsService,
  ) {}

  private async findProvider(orgId: string, providerKey: string) {
    const provider = await this.db.query.paymentProviders.findFirst({
      where: and(eq(paymentProviders.orgId, orgId), eq(paymentProviders.providerKey, providerKey)),
    });
    if (!provider) throw new NotFoundException(`Payment provider not configured: ${providerKey}`);
    return provider;
  }

  async getReadiness(orgId: string, providerKey: string): Promise<ReadinessResult> {
    const provider = await this.findProvider(orgId, providerKey);
    const completedChecks: string[] = [];
    const blockers: string[] = [];
    const warnings: string[] = [];

    const [testCred, liveCred] = await Promise.all([
      this.db.query.paymentProviderCredentials.findFirst({
        where: and(
          eq(paymentProviderCredentials.orgId, orgId),
          eq(paymentProviderCredentials.providerId, provider.id),
          eq(paymentProviderCredentials.environment, "test"),
        ),
      }),
      this.db.query.paymentProviderCredentials.findFirst({
        where: and(
          eq(paymentProviderCredentials.orgId, orgId),
          eq(paymentProviderCredentials.providerId, provider.id),
          eq(paymentProviderCredentials.environment, "live"),
        ),
      }),
    ]);

    if (testCred?.keyId && testCred.secretRef) {
      completedChecks.push("test_credentials_saved");
    } else {
      blockers.push("Add test credentials before activating live payments.");
    }

    if (liveCred?.keyId && liveCred.secretRef) {
      completedChecks.push("live_credentials_saved");
    } else {
      blockers.push("Add live credentials (key ID and secret).");
    }

    const adapter = this.registry.get(providerKey);
    if (adapter?.validateCredentialFormat && liveCred?.keyId) {
      const warning = adapter.validateCredentialFormat("live", liveCred.keyId);
      if (warning) blockers.push(warning.message);
    }

    const liveWebhook = await this.db.query.paymentWebhookEndpoints.findFirst({
      where: and(
        eq(paymentWebhookEndpoints.orgId, orgId),
        eq(paymentWebhookEndpoints.providerId, provider.id),
        eq(paymentWebhookEndpoints.environment, "live"),
      ),
    });
    if (liveWebhook?.status === "verified") {
      completedChecks.push("live_webhook_verified");
    } else if (liveWebhook?.status === "failing") {
      blockers.push("The live webhook is failing signature verification — re-check the webhook secret.");
    } else {
      blockers.push("Verify the live webhook endpoint before activating live payments.");
    }

    const succeededTestPayment = await this.db.query.paymentTestTransactions.findFirst({
      columns: { id: true },
      where: and(
        eq(paymentTestTransactions.orgId, orgId),
        eq(paymentTestTransactions.providerId, provider.id),
        eq(paymentTestTransactions.status, "succeeded"),
      ),
    });
    if (succeededTestPayment) {
      completedChecks.push("test_payment_succeeded");
    } else {
      blockers.push("Run a successful test payment before activating live payments.");
    }

    const account = await this.db.query.paymentProviderAccounts.findFirst({
      where: and(
        eq(paymentProviderAccounts.orgId, orgId),
        eq(paymentProviderAccounts.providerId, provider.id),
      ),
    });
    if (!account) {
      warnings.push("Business details / KYC have not been recorded for this provider.");
    } else if (account.kycStatus && account.kycStatus !== "approved" && account.kycStatus !== "not_required") {
      blockers.push(`Verification (KYC) status is "${account.kycStatus}" — complete it before activating live payments.`);
    } else {
      completedChecks.push("kyc_verified");
    }

    return { completedChecks, blockers, warnings, readyForLive: blockers.length === 0 };
  }

  async activateLive(orgId: string, providerKey: string, actor: RequestActorContext) {
    const provider = await this.findProvider(orgId, providerKey);
    const readiness = await this.getReadiness(orgId, providerKey);

    if (!readiness.readyForLive) {
      await this.audit.log({
        orgId,
        actorUserId: actor.userId,
        providerId: provider.id,
        action: "payment_provider.live_activation_blocked",
        environment: "live",
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        afterRedacted: { blockers: readiness.blockers },
      });
      this.paymentAnalytics.track(orgId, actor.userId, "payment_live_activation_blocked", {
        metadata: { providerKey, blockers: readiness.blockers },
      });
      await this.paymentAnalytics.notifyOwner(orgId, {
        title: "Live payment activation blocked",
        message: `${providerKey} live activation was blocked: ${readiness.blockers[0] ?? "critical checks incomplete"}`,
        type: "WARNING",
        priority: "HIGH",
      });
      throw new BadRequestException({
        message: "Cannot activate live payments — critical checks are incomplete.",
        blockers: readiness.blockers,
      });
    }

    const [updated] = await this.db
      .update(paymentProviders)
      .set({ status: "live", environment: "live" })
      .where(eq(paymentProviders.id, provider.id))
      .returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: provider.id,
      action: "payment_provider.live_activated",
      environment: "live",
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    this.paymentAnalytics.track(orgId, actor.userId, "payment_live_activated", { metadata: { providerKey } });
    await this.paymentAnalytics.notifyOwner(orgId, {
      title: "Live payments activated",
      message: `${providerKey} is now live and can accept real customer payments.`,
      type: "SUCCESS",
      priority: "NORMAL",
    });

    return updated;
  }
}
