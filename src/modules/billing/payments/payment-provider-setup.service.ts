import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { paymentProviderCredentials, paymentProviders } from "../../../db/schema";
import { decryptSecret, encryptSecret, maskSecretHint } from "../../../common/security/secret-encryption.util";
import { PAYMENT_PROVIDER_CATALOG, getCatalogEntry } from "./payment-provider-catalog";
import { PaymentProviderAdapterRegistry, type PaymentCredentialWarning } from "./payment-provider-adapter.interface";
import { PaymentAuditService } from "./payment-audit.service";
import { PaymentAnalyticsService } from "./payment-analytics.service";
import type { SaveCredentialsInput, UpdateProviderInput } from "./dto/payments.schemas";
import type { RequestActorContext } from "../../../common/audit/actor-context";
import { assertOrganizationActor } from "../../../common/organization/organization-actor";


@Injectable()
export class PaymentProviderSetupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: PaymentProviderAdapterRegistry,
    private readonly audit: PaymentAuditService,
    private readonly paymentAnalytics: PaymentAnalyticsService,
  ) {}

  getCatalog() {
    return PAYMENT_PROVIDER_CATALOG;
  }

  private async findProvider(orgId: string, providerKey: string) {
    const provider = await this.db.query.paymentProviders.findFirst({
      where: and(eq(paymentProviders.orgId, orgId), eq(paymentProviders.providerKey, providerKey)),
    });
    if (!provider) throw new NotFoundException(`Payment provider not configured: ${providerKey}`);
    return provider;
  }

  private async credentialsFor(providerId: number) {
    return this.db.query.paymentProviderCredentials.findMany({
      where: eq(paymentProviderCredentials.providerId, providerId),
    });
  }

  private toPublicCredential(cred: typeof paymentProviderCredentials.$inferSelect) {
    return {
      environment: cred.environment,
      maskedKeyHint: cred.maskedKeyHint,
      hasSecret: !!cred.secretRef,
      hasWebhookSecret: !!cred.webhookSecretRef,
      lastRotatedAt: cred.lastRotatedAt,
    };
  }

  async listProviders(orgId: string) {
    const providers = await this.db.query.paymentProviders.findMany({
      where: eq(paymentProviders.orgId, orgId),
    });

    return Promise.all(
      providers.map(async (p) => {
        const creds = await this.credentialsFor(p.id);
        return { ...p, credentials: creds.map((c) => this.toPublicCredential(c)) };
      }),
    );
  }

  async getProvider(orgId: string, providerKey: string) {
    const provider = await this.findProvider(orgId, providerKey);
    const creds = await this.credentialsFor(provider.id);
    return { ...provider, credentials: creds.map((c) => this.toPublicCredential(c)) };
  }

  async createProvider(orgId: string, providerKey: string, actor: RequestActorContext) {
    await assertOrganizationActor(this.db, orgId, { kind: "user", userId: actor.userId });
    const catalogEntry = getCatalogEntry(providerKey);
    if (!catalogEntry) throw new BadRequestException(`Unknown payment provider: ${providerKey}`);

    const existing = await this.db.query.paymentProviders.findFirst({
      where: and(eq(paymentProviders.orgId, orgId), eq(paymentProviders.providerKey, providerKey)),
    });
    if (existing) return existing;

    const [created] = await this.db
      .insert(paymentProviders)
      .values({
        orgId,
        providerKey,
        displayName: catalogEntry.displayName,
        status: "not_configured",
        environment: "test",
        supportedCurrencies: catalogEntry.supportedCurrencies,
        supportedPaymentMethods: catalogEntry.supportedPaymentMethods,
      })
      .returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: created.id,
      action: "payment_provider.created",
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      afterRedacted: { providerKey, status: created.status },
    });
    this.paymentAnalytics.track(orgId, actor.userId, "payment_setup_started", { metadata: { providerKey } });
    this.paymentAnalytics.track(orgId, actor.userId, "payment_provider_selected", { metadata: { providerKey } });

    return created;
  }

  async updateProvider(orgId: string, providerKey: string, patch: UpdateProviderInput, actor: RequestActorContext) {
    await assertOrganizationActor(this.db, orgId, { kind: "user", userId: actor.userId });
    const provider = await this.findProvider(orgId, providerKey);
    const [updated] = await this.db
      .update(paymentProviders)
      .set(patch)
      .where(eq(paymentProviders.id, provider.id))
      .returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: provider.id,
      action: "payment_provider.updated",
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      beforeRedacted: { isPrimary: provider.isPrimary },
      afterRedacted: { isPrimary: updated.isPrimary },
    });

    return updated;
  }

  async disableProvider(orgId: string, providerKey: string, actor: RequestActorContext) {
    await assertOrganizationActor(this.db, orgId, { kind: "user", userId: actor.userId });
    const provider = await this.findProvider(orgId, providerKey);
    const [updated] = await this.db
      .update(paymentProviders)
      .set({ status: "disabled" })
      .where(eq(paymentProviders.id, provider.id))
      .returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: provider.id,
      action: "payment_provider.disabled",
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      beforeRedacted: { status: provider.status },
      afterRedacted: { status: "disabled" },
    });

    return updated;
  }

  async saveCredentials(orgId: string, providerKey: string, input: SaveCredentialsInput, actor: RequestActorContext) {
    await assertOrganizationActor(this.db, orgId, { kind: "user", userId: actor.userId });
    const provider = await this.findProvider(orgId, providerKey);
    const adapter = this.registry.get(providerKey);

    let warning: PaymentCredentialWarning | null = null;
    if (adapter?.validateCredentialFormat && input.keyId) {
      warning = adapter.validateCredentialFormat(input.environment, input.keyId);
    }

    const existing = await this.db.query.paymentProviderCredentials.findFirst({
      where: and(
        eq(paymentProviderCredentials.providerId, provider.id),
        eq(paymentProviderCredentials.environment, input.environment),
      ),
    });

    const values = {
      orgId,
      providerId: provider.id,
      environment: input.environment,
      ...(input.keyId ? { keyId: input.keyId, maskedKeyHint: maskSecretHint(input.keyId) } : {}),
      ...(input.secret ? { secretRef: encryptSecret(input.secret) } : {}),
      ...(input.webhookSecret ? { webhookSecretRef: encryptSecret(input.webhookSecret) } : {}),
      lastRotatedAt: new Date(),
      updatedBy: actor.userId,
    };

    const [saved] = existing
      ? await this.db
          .update(paymentProviderCredentials)
          .set(values)
          .where(eq(paymentProviderCredentials.id, existing.id))
          .returning()
      : await this.db
          .insert(paymentProviderCredentials)
          .values({ ...values, createdBy: actor.userId })
          .returning();

    const nextStatus =
      provider.status === "not_configured" || provider.status === "needs_credentials"
        ? input.environment === "test"
          ? "test_mode_ready"
          : "needs_webhook"
        : provider.status;
    if (nextStatus !== provider.status) {
      await this.db.update(paymentProviders).set({ status: nextStatus }).where(eq(paymentProviders.id, provider.id));
    }

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: provider.id,
      action: existing ? "payment_credentials.rotated" : "payment_credentials.saved",
      environment: input.environment,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      afterRedacted: { maskedKeyHint: saved.maskedKeyHint, environment: input.environment },
    });
    this.paymentAnalytics.track(orgId, actor.userId, "payment_credentials_saved", {
      metadata: { providerKey, environment: input.environment },
    });

    return { credential: this.toPublicCredential(saved), warning };
  }

  async disconnectCredentials(orgId: string, providerKey: string, environment: "test" | "live", actor: RequestActorContext) {
    const provider = await this.findProvider(orgId, providerKey);
    const existing = await this.db.query.paymentProviderCredentials.findFirst({
      where: and(
        eq(paymentProviderCredentials.providerId, provider.id),
        eq(paymentProviderCredentials.environment, environment),
      ),
    });
    if (!existing) throw new NotFoundException(`No ${environment} credentials configured`);

    await this.db.delete(paymentProviderCredentials).where(eq(paymentProviderCredentials.id, existing.id));

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: provider.id,
      action: "payment_credentials.disconnected",
      environment,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return { success: true };
  }

  /** For internal use by webhook/test-transaction/live-activation services — never exposed via API. */
  async getDecryptedSecret(orgId: string, providerId: number, environment: "test" | "live") {
    // In the organisation's own transaction: the credentials table is under
    // row-level security, and the caller that needs it most is a provider
    // webhook, which arrives with no tenant context at all.
    const cred = await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx.query.paymentProviderCredentials.findFirst({
        where: and(
          eq(paymentProviderCredentials.orgId, orgId),
          eq(paymentProviderCredentials.providerId, providerId),
          eq(paymentProviderCredentials.environment, environment),
        ),
      }),
    );
    if (!cred) return null;
    return {
      keyId: cred.keyId,
      secret: cred.secretRef ? decryptSecret(cred.secretRef) : null,
      webhookSecret: cred.webhookSecretRef ? decryptSecret(cred.webhookSecretRef) : null,
    };
  }
}
