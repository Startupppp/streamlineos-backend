import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  paymentProviders,
  paymentWebhookEndpoints,
  paymentWebhookEvents,
} from "../../../db/schema";
import { getCatalogEntry } from "./payment-provider-catalog";
import { PaymentProviderResolver } from "./payment-provider-resolver.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PaymentAnalyticsService } from "./payment-analytics.service";
import type { RequestActorContext } from "../../../common/audit/actor-context";

@Injectable()
export class PaymentWebhookHealthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly providers: PaymentProviderResolver,
    private readonly audit: PaymentAuditService,
    private readonly paymentAnalytics: PaymentAnalyticsService,
  ) {}

  private async findProvider(orgId: string, providerKey: string) {
    const provider = await this.db.query.paymentProviders.findFirst({
      where: and(
        eq(paymentProviders.orgId, orgId),
        eq(paymentProviders.providerKey, providerKey),
      ),
    });
    if (!provider)
      throw new NotFoundException(
        `Payment provider not configured: ${providerKey}`,
      );
    return provider;
  }

  async generateEndpoint(
    orgId: string,
    providerKey: string,
    environment: "test" | "live",
    apiBaseUrl: string,
    actor: RequestActorContext,
  ) {
    const provider = await this.findProvider(orgId, providerKey);
    const catalogEntry = getCatalogEntry(providerKey);
    const url = `${apiBaseUrl.replace(/\/$/, "")}/webhooks/payments/${providerKey}/${environment}/${orgId}`;

    const existing = await this.db.query.paymentWebhookEndpoints.findFirst({
      where: and(
        eq(paymentWebhookEndpoints.providerId, provider.id),
        eq(paymentWebhookEndpoints.environment, environment),
      ),
    });

    const values = {
      orgId,
      providerId: provider.id,
      environment,
      url,
      expectedEvents: catalogEntry?.expectedWebhookEvents ?? [],
    };

    const [endpoint] = existing
      ? await this.db
          .update(paymentWebhookEndpoints)
          .set(values)
          .where(eq(paymentWebhookEndpoints.id, existing.id))
          .returning()
      : await this.db
          .insert(paymentWebhookEndpoints)
          .values({ ...values, status: "not_verified" })
          .returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: provider.id,
      action: "payment_webhook.generated",
      environment,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      afterRedacted: { url },
    });
    this.paymentAnalytics.track(
      orgId,
      actor.userId,
      "payment_webhook_generated",
      { metadata: { providerKey, environment } },
    );

    return endpoint;
  }

  async verifyEndpointManual(
    orgId: string,
    providerKey: string,
    environment: "test" | "live",
    sample: { rawBody: string; signature: string } | undefined,
    actor: RequestActorContext,
  ) {
    const provider = await this.findProvider(orgId, providerKey);
    const endpoint = await this.db.query.paymentWebhookEndpoints.findFirst({
      where: and(
        eq(paymentWebhookEndpoints.providerId, provider.id),
        eq(paymentWebhookEndpoints.environment, environment),
      ),
    });
    if (!endpoint)
      throw new BadRequestException(
        "Generate the webhook endpoint before verifying it",
      );

    if (!sample) {
      return endpoint;
    }

    const providerFacade = await this.providers.resolve(
      orgId,
      providerKey,
      environment,
    );
    if (!providerFacade)
      throw new BadRequestException(
        `No backend integration available for provider: ${providerKey}`,
      );

    const valid = providerFacade.verifyWebhookSignature({
      rawBody: sample.rawBody,
      signature: sample.signature,
    });

    const [updated] = await this.db
      .update(paymentWebhookEndpoints)
      .set(
        valid
          ? {
              status: "verified",
              lastVerifiedAt: new Date(),
              failureReason: null,
            }
          : {
              status: "failing",
              lastFailureAt: new Date(),
              failureReason: "Sample signature did not match",
            },
      )
      .where(eq(paymentWebhookEndpoints.id, endpoint.id))
      .returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: provider.id,
      action: valid
        ? "payment_webhook.verified"
        : "payment_webhook.verification_failed",
      environment,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    if (valid) {
      this.paymentAnalytics.track(
        orgId,
        actor.userId,
        "payment_webhook_verified",
        { metadata: { providerKey, environment } },
      );
    }

    return updated;
  }

  async listEvents(orgId: string, providerKey: string, limit = 50) {
    const provider = await this.findProvider(orgId, providerKey);
    return this.db.query.paymentWebhookEvents.findMany({
      where: and(
        eq(paymentWebhookEvents.orgId, orgId),
        eq(paymentWebhookEvents.providerId, provider.id),
      ),
      orderBy: desc(paymentWebhookEvents.receivedAt),
      limit,
    });
  }

  async retryEvent(
    orgId: string,
    providerKey: string,
    eventId: number,
    actor: RequestActorContext,
  ) {
    const provider = await this.findProvider(orgId, providerKey);
    const event = await this.db.query.paymentWebhookEvents.findFirst({
      where: and(
        eq(paymentWebhookEvents.id, eventId),
        eq(paymentWebhookEvents.orgId, orgId),
        eq(paymentWebhookEvents.providerId, provider.id),
      ),
    });
    if (!event) throw new NotFoundException("Webhook event not found");

    const [updated] = await this.db
      .update(paymentWebhookEvents)
      .set({
        processingStatus: "processed",
        processedAt: new Date(),
        errorMessage: null,
      })
      .where(
        and(
          eq(paymentWebhookEvents.id, eventId),
          eq(paymentWebhookEvents.orgId, orgId),
          eq(paymentWebhookEvents.providerId, provider.id),
        ),
      )
      .returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: provider.id,
      action: "payment_webhook_event.retried",
      environment: event.environment,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return updated;
  }
}
