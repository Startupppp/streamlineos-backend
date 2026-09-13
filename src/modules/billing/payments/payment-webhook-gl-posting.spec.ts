jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async <T>(_db: unknown, fn: (tx: unknown) => Promise<T>, _opts?: unknown) => fn(_db),
  runInNewTenantTransaction: async <T>(_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) => fn(_db),
}));

import { DRIZZLE } from "../../../db/drizzle.constants";
import { Test } from "@nestjs/testing";
import { PaymentWebhookReceiverService } from "./payment-webhook-receiver.service";
import { PaymentProviderResolver } from "./payment-provider-resolver.service";
import { PaymentAnalyticsService } from "./payment-analytics.service";
import { PostingCommandService } from "../../accounting/adapters/posting-command.service";
import { AdapterRejection } from "../../accounting/adapters/posting-command.types";
import {
  FakeProviderAdapter,
  FAKE_VALID_WEBHOOK_SIG,
  FAKE_WEBHOOK_SECRET,
} from "./testing/fake-provider-adapter";
import type { OrganizationPaymentProvider } from "./payment-provider-resolver.service";

const CAPTURED_BODY = JSON.stringify({
  event: "payment.captured",
  payload: {
    payment: {
      entity: {
        id: "pay_gl_001",
        amount: 49900,
        currency: "INR",
        status: "captured",
        method: "card",
        notes: {},
        createdAt: 1700000000,
      },
    },
  },
});

const REFUND_BODY = JSON.stringify({
  event: "refund.created",
  payload: {},
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
      adapter.verifyWebhookSignature({ ...params, webhookSecret: FAKE_WEBHOOK_SECRET }),
    normalizeWebhook: (rawBody) => adapter.normalizeWebhook(rawBody),
    fetchPayment: async () => null,
  };
}

function makeSelectResult(rows: unknown[]) {
  const p = Promise.resolve(rows);
  return Object.assign(p, { limit: () => p });
}

function makeUpdateChain() {
  return { set: () => ({ where: () => Promise.resolve([]) }) };
}

function buildDb(insertedRow: unknown) {
  const providerRow = { id: "prov-1", orgId: "org-a", providerKey: "razorpay", status: "healthy" };
  const endpointRow = { id: "ep-1", orgId: "org-a", providerId: "prov-1", status: "verified" };
  return {
    insert: jest.fn().mockReturnValue({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(insertedRow ? [insertedRow] : []),
        }),
        onConflictDoUpdate: () => Promise.resolve([]),
      }),
    }),
    select: jest.fn().mockReturnValue({
      from: () => ({
        where: () => makeSelectResult([providerRow, endpointRow]),
      }),
    }),
    update: jest.fn().mockReturnValue(makeUpdateChain()),
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    ),
  };
}

function makePostingCmd(overrides: Partial<{ submit: jest.Mock }> = {}) {
  return {
    submit: jest.fn().mockResolvedValue({ journalId: "jrn-1", journalNumber: "JNL-001", replayed: false }),
    ...overrides,
  };
}

async function buildService(
  db: unknown,
  postingCmd: unknown,
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

  const module = await Test.createTestingModule({
    providers: [
      PaymentWebhookReceiverService,
      { provide: DRIZZLE, useValue: db },
      { provide: PaymentProviderResolver, useValue: resolver },
      { provide: PaymentAnalyticsService, useValue: analytics },
      { provide: PostingCommandService, useValue: postingCmd },
    ],
  }).compile();

  return { svc: module.get(PaymentWebhookReceiverService), analytics };
}

describe("payment.captured webhook — GL posting", () => {
  it("posts a journal entry when a payment.captured event is first seen", async () => {
    const insertedRow = { id: 42 };
    const db = buildDb(insertedRow);
    const postingCmd = makePostingCmd();
    const { svc } = await buildService(db, postingCmd, makeProvider());

    const result = await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-a",
      rawBody: CAPTURED_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: undefined,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });
    expect(postingCmd.submit).toHaveBeenCalledTimes(1);

    const [callOrgId, callUserId, callCommand] = postingCmd.submit.mock.calls[0] as [
      string,
      null,
      { sourceType: string; sourceId: string; purpose: string; lines: unknown[] },
    ];
    expect(callOrgId).toBe("org-a");
    expect(callUserId).toBeNull();
    expect(callCommand.sourceType).toBe("receipt");
    expect(callCommand.sourceId).toBe(String(insertedRow.id));
    expect(callCommand.purpose).toBe("post");
    expect(callCommand.lines).toHaveLength(2);
  });

  it("does not post a second journal entry when the same event arrives again (duplicate webhook)", async () => {
    const insertedRow = { id: 42 };
    const db = buildDb(insertedRow);
    const postingCmd = makePostingCmd();
    const { svc } = await buildService(db, postingCmd, makeProvider());

    await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-a",
      rawBody: CAPTURED_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: undefined,
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
      rawBody: CAPTURED_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: undefined,
    });

    expect(second.body).toMatchObject({ ok: true, duplicate: true });
    expect(postingCmd.submit).toHaveBeenCalledTimes(1);
  });

  it("does not post when the event is not a payment capture", async () => {
    const insertedRow = { id: 43 };
    const db = buildDb(insertedRow);
    const postingCmd = makePostingCmd();
    const { svc } = await buildService(db, postingCmd, makeProvider());

    await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-a",
      rawBody: REFUND_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: undefined,
    });

    expect(postingCmd.submit).not.toHaveBeenCalled();
  });

  it("returns 200 and does not throw when accounting is not enabled (BOOK_NOT_ENABLED)", async () => {
    const insertedRow = { id: 44 };
    const db = buildDb(insertedRow);
    const postingCmd = makePostingCmd({
      submit: jest.fn().mockRejectedValue(
        new AdapterRejection("BOOK_NOT_ENABLED", "Accounting is not enabled"),
      ),
    });
    const { svc } = await buildService(db, postingCmd, makeProvider());

    const result = await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-a",
      rawBody: CAPTURED_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: undefined,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });
  });

  it("uses razorpay_clearing for Razorpay provider", async () => {
    const insertedRow = { id: 45 };
    const db = buildDb(insertedRow);
    const postingCmd = makePostingCmd();
    const { svc } = await buildService(db, postingCmd, makeProvider());

    await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-a",
      rawBody: CAPTURED_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: undefined,
    });

    const [, , command] = postingCmd.submit.mock.calls[0] as [
      string,
      null,
      { lines: Array<{ accountTag?: string; debitMinor?: number; creditMinor?: number }> },
    ];
    const debitLine = command.lines.find((l) => l.debitMinor !== undefined);
    expect(debitLine?.accountTag).toBe("razorpay_clearing");
    const creditLine = command.lines.find((l) => l.creditMinor !== undefined);
    expect(creditLine?.accountTag).toBe("ar_control");
  });

  it("debit and credit amounts match the captured amount in minor units", async () => {
    const insertedRow = { id: 46 };
    const db = buildDb(insertedRow);
    const postingCmd = makePostingCmd();
    const { svc } = await buildService(db, postingCmd, makeProvider());

    await svc.processIncomingWebhook({
      providerKey: "razorpay",
      environment: "test",
      orgId: "org-a",
      rawBody: CAPTURED_BODY,
      signature: FAKE_VALID_WEBHOOK_SIG,
      providerEventIdHeader: undefined,
    });

    const [, , command] = postingCmd.submit.mock.calls[0] as [
      string,
      null,
      { lines: Array<{ accountTag?: string; debitMinor?: number; creditMinor?: number; currency?: string }> },
    ];
    const debitLine = command.lines.find((l) => l.debitMinor !== undefined);
    const creditLine = command.lines.find((l) => l.creditMinor !== undefined);
    expect(debitLine?.debitMinor).toBe(49900);
    expect(creditLine?.creditMinor).toBe(49900);
    expect(debitLine?.currency).toBe("INR");
  });
});
