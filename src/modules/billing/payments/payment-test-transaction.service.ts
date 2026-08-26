import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { paymentProviders, paymentTestTransactions } from "../../../db/schema";
import { PaymentProviderResolver } from "./payment-provider-resolver.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PaymentAnalyticsService } from "./payment-analytics.service";
import type { CreateTestTransactionInput, VerifyTestTransactionInput } from "./dto/test-transaction.schemas";
import type { RequestActorContext } from "../../../common/audit/actor-context";

@Injectable()
export class PaymentTestTransactionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly providers: PaymentProviderResolver,
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

  // Test payments always run against TEST credentials — never live, regardless of the
  // provider's current environment — per "test mode is a first-class state" (11_...md).
  async createTestTransaction(orgId: string, providerKey: string, input: CreateTestTransactionInput, actor: RequestActorContext) {
    const provider = await this.findProvider(orgId, providerKey);
    const providerFacade = await this.providers.resolve(orgId, providerKey, "test");
    if (!providerFacade?.isReady()) {
      throw new BadRequestException("Add test credentials before running a test payment");
    }

    const [transaction] = await this.db
      .insert(paymentTestTransactions)
      .values({
        orgId,
        providerId: provider.id,
        environment: "test",
        amount: input.amount,
        currency: input.currency,
        status: "created",
        createdBy: actor.userId,
      })
      .returning();

    try {
      const order = await providerFacade.createOrder({
        amount: input.amount,
        currency: input.currency,
        receipt: `test_${transaction.id}`,
        notes: { source: "streamlineos_test_payment", orgId },
      });

      const [updated] = await this.db
        .update(paymentTestTransactions)
        .set({ status: "pending", providerOrderId: order.providerOrderId })
        .where(eq(paymentTestTransactions.id, transaction.id))
        .returning();

      await this.audit.log({
        orgId,
        actorUserId: actor.userId,
        providerId: provider.id,
        action: "payment_test_transaction.created",
        environment: "test",
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        afterRedacted: { amount: input.amount, currency: input.currency, providerOrderId: order.providerOrderId },
      });
      this.paymentAnalytics.track(orgId, actor.userId, "payment_test_payment_started", { metadata: { providerKey } });

      return { ...updated, keyId: providerFacade.publicKeyId() };
    } catch (err) {
      await this.db
        .update(paymentTestTransactions)
        .set({ status: "failed", resultSummary: err instanceof Error ? err.message : "Order creation failed" })
        .where(eq(paymentTestTransactions.id, transaction.id));
      throw err;
    }
  }

  async verifyTestTransaction(orgId: string, providerKey: string, id: number, input: VerifyTestTransactionInput, actor: RequestActorContext) {
    const provider = await this.findProvider(orgId, providerKey);
    const transaction = await this.db.query.paymentTestTransactions.findFirst({
      where: and(eq(paymentTestTransactions.id, id), eq(paymentTestTransactions.orgId, orgId)),
    });
    if (!transaction || !transaction.providerOrderId) {
      throw new NotFoundException("Test transaction not found");
    }

    const providerFacade = await this.providers.resolve(orgId, providerKey, "test");
    if (!providerFacade?.isReady()) throw new BadRequestException("Test credentials are no longer configured");

    const signatureValid = providerFacade.verifyPaymentSignature({
      orderId: transaction.providerOrderId,
      paymentId: input.providerPaymentId,
      signature: input.signature,
    });

    const [updated] = await this.db
      .update(paymentTestTransactions)
      .set({
        providerPaymentId: input.providerPaymentId,
        signatureVerified: signatureValid,
        status: signatureValid ? "succeeded" : "failed",
        resultSummary: signatureValid ? "Signature verified" : "Signature verification failed",
      })
      .where(eq(paymentTestTransactions.id, id))
      .returning();

    await this.audit.log({
      orgId,
      actorUserId: actor.userId,
      providerId: provider.id,
      action: signatureValid ? "payment_test_transaction.succeeded" : "payment_test_transaction.failed",
      environment: "test",
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    this.paymentAnalytics.track(
      orgId,
      actor.userId,
      signatureValid ? "payment_test_payment_succeeded" : "payment_test_payment_failed",
      { metadata: { providerKey } },
    );

    return updated;
  }

  async listForProvider(orgId: string, providerKey: string) {
    const provider = await this.findProvider(orgId, providerKey);
    return this.db.query.paymentTestTransactions.findMany({
      where: and(eq(paymentTestTransactions.orgId, orgId), eq(paymentTestTransactions.providerId, provider.id)),
    });
  }
}
