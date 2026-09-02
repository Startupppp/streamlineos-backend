import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "./plan-limits.service";
import { ProrationLedgerService } from "./proration-ledger.service";
import { VersionedCatalogService } from "./versioned-catalog.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { PaymentProviderResolver, type OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";
import { PaymentWebhookReceiverService } from "../payments/payment-webhook-receiver.service";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import { BillingProfileService } from "./billing-profile.service";
import { AiCreditsService } from "./ai-credits.service";
import { BillingService } from "./billing.service";
import {
  FakeProviderAdapter,
  FAKE_VALID_PAYMENT_SIG,
  FAKE_PROVIDER_ORDER_ID,
} from "../payments/testing/fake-provider-adapter";
import { confirmCheckoutSchema } from "./dto/billing.schemas";

function makeStripeProvider(): OrganizationPaymentProvider {
  const adapter = new FakeProviderAdapter("stripe");
  return {
    providerKey: "stripe",
    environment: "test",
    isReady: () => adapter.configure({ secret: "sk_test_fake" }).isReady(),
    publicKeyId: () => adapter.configure({ keyId: "pk_test_fake" }).publicKeyId(),
    createOrder: (params) =>
      adapter.configure({ keyId: "pk_test_fake", secret: "sk_test_fake" }).createOrder(params),
    verifyPaymentSignature: (params) =>
      adapter.configure({ secret: "sk_test_fake" }).verifyPaymentSignature(params),
    verifyWebhookSignature: (params) =>
      adapter.configure({ webhookSecret: "wh_test_fake" }).verifyWebhookSignature(params),
    normalizeWebhook: (rawBody) => adapter.configure(null).normalizeWebhook(rawBody),
  };
}

function makeStripeResolver(): PaymentProviderResolver {
  const provider = makeStripeProvider();
  return {
    resolve: jest.fn().mockResolvedValue(provider),
    resolveConfigured: jest.fn().mockResolvedValue(provider),
  } as unknown as PaymentProviderResolver;
}

function makeTx() {
  const rows = [{ id: 1 }];
  return {
    query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } },
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(rows),
        then: (resolve: (v: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
      }),
    }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      for: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    }),
    execute: jest.fn().mockResolvedValue([]),
  };
}

function makeDb() {
  const tx = makeTx();
  return {
    transaction: jest.fn().mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([{ baseCurrency: "INR" }]),
    }),
    _tx: tx,
  };
}

async function buildService(providers: PaymentProviderResolver): Promise<BillingService> {
  const module = await Test.createTestingModule({
    providers: [
      BillingService,
      RevenueAnalyticsService,
      { provide: DRIZZLE, useValue: makeDb() },
      { provide: OutboxConsumerRegistry, useValue: { register: jest.fn(), get: jest.fn() } },
      {
        provide: AiCreditsService,
        useValue: { grantPlanCredits: jest.fn().mockResolvedValue(undefined), listPacks: jest.fn().mockResolvedValue([]) },
      },
      { provide: AuditService, useValue: { log: jest.fn(), logCritical: jest.fn() } },
      { provide: PlanLimitsService, useValue: { bust: jest.fn(), resolveTier: jest.fn().mockResolvedValue({ plan: "STARTER" }) } },
      { provide: ProrationLedgerService, useValue: { recordPlanChange: jest.fn().mockResolvedValue(undefined) } },
      { provide: VersionedCatalogService, useValue: { getActivePriceForPlanTier: jest.fn().mockResolvedValue(null) } },
      { provide: PaymentProviderResolver, useValue: providers },
      {
        provide: ExternalEffectLedger,
        useValue: {
          execute: jest.fn().mockImplementation(async (_: unknown, send: () => Promise<void>) => {
            await send();
            return "EXECUTED";
          }),
        },
      },
      { provide: PaymentWebhookReceiverService, useValue: { recordSignatureFailure: jest.fn() } },
      { provide: PaymentAnalyticsService, useValue: { notifyOwner: jest.fn(), track: jest.fn() } },
      { provide: BillingProfileService, useValue: { get: jest.fn(), update: jest.fn() } },
    ],
  }).compile();
  return module.get(BillingService);
}

describe("confirmCheckoutSchema — provider-neutral contract (PRD 10.10-A)", () => {
  it("rejects Razorpay-named fields (razorpay_order_id / razorpay_payment_id / razorpay_signature)", () => {
    const result = confirmCheckoutSchema.safeParse({
      razorpay_order_id: "order_1",
      razorpay_payment_id: "pay_1",
      razorpay_signature: "sig",
      plan: "STARTER",
    });
    expect(result.success).toBe(false);
  });

  it("accepts neutral orderId, paymentId, signature", () => {
    const result = confirmCheckoutSchema.safeParse({
      orderId: "order_1",
      paymentId: "pay_1",
      signature: "sig",
      plan: "STARTER",
    });
    expect(result.success).toBe(true);
  });

  it("rejects extra fields (strict schema)", () => {
    const result = confirmCheckoutSchema.safeParse({
      orderId: "order_1",
      paymentId: "pay_1",
      signature: "sig",
      plan: "STARTER",
      unexpectedField: "x",
    });
    expect(result.success).toBe(false);
  });
});

describe("BillingService — Stripe-ready contract (PRD 10.10-A)", () => {
  it("a stripe-keyed adapter activates through the same verifyAndActivate without any Razorpay field in the call path", async () => {
    const svc = await buildService(makeStripeResolver());
    const result = await svc.verifyAndActivate("org_stripe_1", "user_1", {
      orderId: FAKE_PROVIDER_ORDER_ID,
      paymentId: "pi_stripe_abc",
      signature: FAKE_VALID_PAYMENT_SIG,
      plan: "STARTER",
    });
    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
  });

  it("createOrder via stripe adapter returns neutral orderId without Razorpay naming", async () => {
    const svc = await buildService(makeStripeResolver());
    const result = await svc.createOrder("org_stripe_1", "user_1", "STARTER");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
    expect(result).not.toHaveProperty("razorpay_order_id");
    expect(result).not.toHaveProperty("razorpayOrderId");
  });

  it("wrong signature from a stripe adapter throws BadRequestException without any Razorpay-specific path", async () => {
    const svc = await buildService(makeStripeResolver());
    await expect(svc.verifyAndActivate("org_stripe_1", "user_1", {
      orderId: FAKE_PROVIDER_ORDER_ID,
      paymentId: "pi_stripe_abc",
      signature: "invalid-stripe-signature",
      plan: "STARTER",
    })).rejects.toBeInstanceOf(BadRequestException);
  });
});
