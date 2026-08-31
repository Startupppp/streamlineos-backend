jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { PaymentProviderResolver } from "./payment-provider-resolver.service";
import { PaymentWebhookReceiverService } from "./payment-webhook-receiver.service";
import type { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";
import type { PaymentProviderSetupService } from "./payment-provider-setup.service";
import type { PaymentAnalyticsService } from "./payment-analytics.service";
import type { ProviderBridgeService } from "../../finance/controls/provider-bridge.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

const mockRunInTenantTransaction = runInTenantTransaction as jest.MockedFunction<typeof runInTenantTransaction>;

beforeEach(() => {
  jest.resetAllMocks();
  mockRunInTenantTransaction.mockImplementation(
    async (_db, fn, _opts) => fn({} as Parameters<typeof fn>[0]),
  );
});

describe("PaymentProviderResolver — cross-tenant isolation", () => {
  function makeResolverDb(providerRow: unknown): Db {
    return {
      query: {
        paymentProviders: {
          findFirst: jest.fn().mockResolvedValue(providerRow),
        },
      },
    } as unknown as Db;
  }

  it("returns undefined when no provider exists for the requesting org (DENY)", async () => {
    const db = makeResolverDb(null);
    const mockRegistry = { get: jest.fn().mockReturnValue(undefined) } as unknown as PaymentProviderAdapterRegistry;
    const mockSetup = {} as unknown as PaymentProviderSetupService;
    const svc = new PaymentProviderResolver(db, mockRegistry, mockSetup);
    const result = await svc.resolve(ATTACKER_ORG, "razorpay");
    expect(result).toBeUndefined();
  });

  it("scopes findFirst to the requesting orgId (predicate check)", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const db = {
      query: { paymentProviders: { findFirst } },
    } as unknown as Db;
    const mockRegistry = { get: jest.fn().mockReturnValue(undefined) } as unknown as PaymentProviderAdapterRegistry;
    const mockSetup = {} as unknown as PaymentProviderSetupService;
    const svc = new PaymentProviderResolver(db, mockRegistry, mockSetup);
    await svc.resolve(ATTACKER_ORG, "razorpay");
    const call = findFirst.mock.calls[0]?.[0];
    expect(sqlValues(call?.where)).toContain(ATTACKER_ORG);
  });

  it("returns a provider facade for the owning org (CONTROL)", async () => {
    const providerRow = { id: 1, orgId: OWNER_ORG, providerKey: "razorpay", status: "active", environment: "test" };
    const db = makeResolverDb(providerRow);
    const mockRuntime = {
      isReady: jest.fn().mockReturnValue(true),
      publicKeyId: jest.fn().mockReturnValue(null),
      createOrder: jest.fn(),
      verifyPaymentSignature: jest.fn(),
      verifyWebhookSignature: jest.fn(),
      normalizeWebhook: jest.fn(),
    };
    const mockAdapter = { configure: jest.fn().mockReturnValue(mockRuntime) };
    const mockRegistry = { get: jest.fn().mockReturnValue(mockAdapter) } as unknown as PaymentProviderAdapterRegistry;
    const mockSetup = {
      getDecryptedSecret: jest.fn().mockResolvedValue({ keyId: "k", secret: "s" }),
    } as unknown as PaymentProviderSetupService;
    const svc = new PaymentProviderResolver(db, mockRegistry, mockSetup);
    const result = await svc.resolve(OWNER_ORG, "razorpay");
    expect(result).toBeDefined();
    expect(result?.providerKey).toBe("razorpay");
  });
});

describe("PaymentWebhookReceiverService — cross-tenant isolation", () => {
  function makeWebhookSvc(analytics?: Partial<typeof mockAnalytics>) {
    const db = {} as unknown as Db;
    const providers = {} as unknown as PaymentProviderResolver;
    const paymentAnalytics = {
      notifyOwner: jest.fn().mockResolvedValue(undefined),
      ...analytics,
    } as unknown as PaymentAnalyticsService;
    const providerBridge = {} as unknown as ProviderBridgeService;
    const svc = new PaymentWebhookReceiverService(db, providers, paymentAnalytics, providerBridge);
    return { svc, paymentAnalytics };
  }

  const mockAnalytics = { notifyOwner: jest.fn() };

  it("returns early without side effects when no provider exists for the org (DENY)", async () => {
    const { svc, paymentAnalytics } = makeWebhookSvc();
    const emptyTx = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    mockRunInTenantTransaction.mockImplementation(async (_db, fn, _opts) =>
      fn(emptyTx as unknown as Parameters<typeof fn>[0]),
    );
    await expect(svc.recordSignatureFailure(ATTACKER_ORG, "razorpay")).resolves.toBeUndefined();
    expect(paymentAnalytics.notifyOwner).not.toHaveBeenCalled();
  });

  it("passes the requesting orgId to runInTenantTransaction (predicate check — DENY)", async () => {
    const { svc } = makeWebhookSvc();
    const emptyTx = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    mockRunInTenantTransaction.mockImplementation(async (_db, fn, _opts) =>
      fn(emptyTx as unknown as Parameters<typeof fn>[0]),
    );
    await svc.recordSignatureFailure(ATTACKER_ORG, "razorpay");
    expect(mockRunInTenantTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      { orgId: ATTACKER_ORG },
    );
  });

  it("records failure and notifies for the owning org (CONTROL)", async () => {
    const { svc, paymentAnalytics } = makeWebhookSvc();

    const tx1 = {
      select: jest.fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ id: 1 }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ id: 5, status: "active" }]),
          }),
        }),
    };
    const tx2 = {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    };

    mockRunInTenantTransaction
      .mockImplementationOnce(async (_db, fn, _opts) => fn(tx1 as unknown as Parameters<typeof fn>[0]))
      .mockImplementationOnce(async (_db, fn, _opts) => fn(tx2 as unknown as Parameters<typeof fn>[0]));

    await svc.recordSignatureFailure(OWNER_ORG, "razorpay");

    expect(paymentAnalytics.notifyOwner).toHaveBeenCalledWith(
      OWNER_ORG,
      expect.objectContaining({ type: "WARNING" }),
    );
  });
});
