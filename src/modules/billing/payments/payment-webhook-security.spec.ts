jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async <T>(_db: unknown, fn: (tx: unknown) => Promise<T>, _opts?: unknown) => fn(_db),
  runInNewTenantTransaction: async <T>(_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) => fn(_db),
}));

import { DRIZZLE } from "../../../db/drizzle.constants";
import { Test } from "@nestjs/testing";
import { PaymentWebhookReceiverService } from "./payment-webhook-receiver.service";
import { PaymentProviderResolver } from "./payment-provider-resolver.service";
import { PaymentAnalyticsService } from "./payment-analytics.service";
import { ProviderBridgeService } from "../../finance/controls/provider-bridge.service";
import {
  FakeProviderAdapter,
  FAKE_VALID_WEBHOOK_SIG,
  FAKE_WEBHOOK_SECRET,
} from "./testing/fake-provider-adapter";
import { effectiveRateLimit } from "../../../common/ratelimit/rate-limit.service";
import type { OrganizationPaymentProvider } from "./payment-provider-resolver.service";

const VALID_RAZORPAY_BODY = JSON.stringify({
  event: "payment.captured",
  payload: {
    payment: {
      entity: {
        id: "pay_sec_001",
        amount: 49900,
        currency: "INR",
        status: "captured",
        method: "card",
        notes: {},
      },
    },
  },
});

function makeProvider(): OrganizationPaymentProvider {
  const adapter = new FakeProviderAdapter("razorpay");
  return {
    providerKey: "razorpay",
    environment: "test",
    isReady: () => adapter.isReady(),
    publicKeyId: () => adapter.publicKeyId(),
    createOrder: (params) =>
      adapter.createOrder({ ...params, keyId: "fake", keySecret: "fake" }),
    verifyPaymentSignature: (params) =>
      adapter.verifyPaymentSignature({ ...params, keySecret: "fake" }),
    verifyWebhookSignature: (params) =>
      adapter.verifyWebhookSignature({
        ...params,
        webhookSecret: FAKE_WEBHOOK_SECRET,
      }),
    normalizeWebhook: (rawBody) => adapter.normalizeWebhook(rawBody),
    fetchPayment: async () => null,
  };
}

function makeInsertChain() {
  return {
    values: () => ({
      onConflictDoNothing: () => ({
        returning: () => Promise.resolve([{ id: "evt-1" }]),
      }),
      onConflictDoUpdate: () => Promise.resolve([]),
    }),
  };
}

function makeUpdateChain() {
  return {
    set: () => ({ where: () => Promise.resolve([]) }),
  };
}

function buildNoProviderDb() {
  return {
    insert: jest.fn(),
    select: jest.fn().mockReturnValue({
      from: () => ({
        where: () => makeSelectResult([]),
      }),
    }),
    update: jest.fn().mockReturnValue(makeUpdateChain()),
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    ),
  };
}

function makeSelectResult(rows: unknown[]) {
  const p = Promise.resolve(rows);
  return Object.assign(p, { limit: () => p });
}

function buildProviderDb() {
  const providerRow = { id: "prov-1", orgId: "org-a", providerKey: "razorpay", status: "healthy" };
  return {
    insert: jest.fn().mockReturnValue(makeInsertChain()),
    select: jest.fn().mockReturnValue({
      from: () => ({
        where: () => makeSelectResult([providerRow]),
      }),
    }),
    update: jest.fn().mockReturnValue(makeUpdateChain()),
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    ),
  };
}

async function buildService(
  db: unknown,
  resolvedProvider: OrganizationPaymentProvider | undefined,
) {
  const resolver = {
    resolve: jest.fn().mockResolvedValue(resolvedProvider),
    resolveConfigured: jest.fn().mockResolvedValue(resolvedProvider),
  };
  const analytics = {
    notifyOwner: jest.fn().mockResolvedValue(undefined),
    track: jest.fn(),
  };
  const bridge = {
    recordProviderPayment: jest.fn().mockResolvedValue(undefined),
  };

  const module = await Test.createTestingModule({
    providers: [
      PaymentWebhookReceiverService,
      { provide: DRIZZLE, useValue: db },
      { provide: PaymentProviderResolver, useValue: resolver },
      { provide: PaymentAnalyticsService, useValue: analytics },
      { provide: ProviderBridgeService, useValue: bridge },
    ],
  }).compile();

  return {
    svc: module.get(PaymentWebhookReceiverService),
    resolver,
    analytics,
  };
}

describe("billing webhook — unknown/unconfigured org returns 404, not 403", () => {
  it("returns 404 when the org has no payment provider row in the DB", async () => {
    const db = buildNoProviderDb();
    const { svc } = await buildService(db, undefined);

    const result = await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-unknown",
      rawBody: VALID_RAZORPAY_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: undefined,
    });

    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ ok: false });
  });

  it("returns 404, not 403 — a 403 leaks that the org exists to an attacker", async () => {
    const db = buildNoProviderDb();
    const { svc } = await buildService(db, undefined);

    const result = await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-not-a-customer",
      rawBody: VALID_RAZORPAY_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: undefined,
    });

    expect(result.status).not.toBe(403);
    expect(result.status).toBe(404);
  });

  it("writes nothing to the DB when the org has no provider row", async () => {
    const db = buildNoProviderDb();
    const { svc } = await buildService(db, undefined);

    await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-unknown",
      rawBody: VALID_RAZORPAY_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: undefined,
    });

    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("billing webhook — invalid signature rejected before any ledger write", () => {
  it("returns 401 when the signature does not match", async () => {
    const db = buildProviderDb();
    const { svc } = await buildService(db, makeProvider());

    const result = await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-a",
      rawBody: VALID_RAZORPAY_BODY,
      signature: "forged-signature",
      providerEventIdHeader: undefined,
    });

    expect(result.status).toBe(401);
  });

  it("writes no ledger row when the signature is rejected", async () => {
    const db = buildProviderDb();
    const { svc } = await buildService(db, makeProvider());

    await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-a",
      rawBody: VALID_RAZORPAY_BODY,
      signature: "forged-signature",
      providerEventIdHeader: undefined,
    });

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("accepts a valid signature and returns 200", async () => {
    const db = buildProviderDb();
    const { svc } = await buildService(db, makeProvider());

    const result = await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-a",
      rawBody: VALID_RAZORPAY_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: undefined,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });
  });

  it("does not notify the owner when signature is valid", async () => {
    const db = buildProviderDb();
    const { svc, analytics } = await buildService(db, makeProvider());

    await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-a",
      rawBody: VALID_RAZORPAY_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: undefined,
    });

    expect(analytics.notifyOwner).not.toHaveBeenCalled();
  });
});

describe("billing webhook — duplicate event accepted only once", () => {
  it("returns 200 ok:true duplicate:true on the second delivery of the same event", async () => {
    const db = buildProviderDb();
    const { svc } = await buildService(db, makeProvider());

    await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-a",
      rawBody: VALID_RAZORPAY_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: "pay_sec_001",
    });

    (db.insert as jest.Mock).mockReturnValue({
      values: () => ({
        onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }),
        onConflictDoUpdate: () => Promise.resolve([]),
      }),
    });

    const second = await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-a",
      rawBody: VALID_RAZORPAY_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: "pay_sec_001",
    });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, duplicate: true });
  });
});

describe("billing rate-limit TIERS registration — failing-open prevention", () => {
  it("billing:webhook tier is declared and bites (non-zero effective limit)", () => {
    expect(effectiveRateLimit("billing:webhook")).toBeGreaterThan(0);
  });

  it("billing:checkout tier is declared and bites (non-zero effective limit)", () => {
    expect(effectiveRateLimit("billing:checkout")).toBeGreaterThan(0);
  });

  it("an unknown billing tier returns 0 — this is the deny-by-default proof", () => {
    expect(effectiveRateLimit("billing:nonexistent-action")).toBe(0);
  });
});
