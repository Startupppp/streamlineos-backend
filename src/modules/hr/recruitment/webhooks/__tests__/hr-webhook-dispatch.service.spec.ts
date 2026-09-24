import { Test, TestingModule } from "@nestjs/testing";
import { HrWebhookDispatchService } from "../hr-webhook-dispatch.service";
import { DRIZZLE } from "../../../../../db/drizzle.constants";
import { hrWebhookDeliveries } from "../../../../../db/schema/hr/webhooks";
import type { ProviderDescriptor } from "../../../../../common/outbound/call-provider";

jest.mock("../../../../../common/outbound/call-provider", () => ({
  callProvider: jest.fn(),
}));
jest.mock("../../../../../common/outbound/safe-webhook-transport", () => ({
  postSafeWebhook: jest.fn(),
}));
jest.mock("../../../../webhooks/lib/webhook-delivery", () => ({
  readSigningSecret: jest.fn(() => "mockSecret"),
  webhookDescriptor: jest.fn((id) => ({ id })),
  logFromResult: jest.fn((result) => ({
    statusCode: result.status,
    responseBody: result.body,
    success: result.status >= 200 && result.status < 300,
    attempts: result.attempts,
  })),
  WEBHOOK_TIMEOUT_MS: 5000,
}));

describe("HrWebhookDispatchService", () => {
  let service: HrWebhookDispatchService;
  let db: any;

  beforeEach(async () => {
    db = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrWebhookDispatchService,
        {
          provide: DRIZZLE,
          useValue: db,
        },
      ],
    }).compile();

    service = module.get<HrWebhookDispatchService>(HrWebhookDispatchService);
  });

  it("should sweep pending deliveries", async () => {
    const pendingDeliveries = [
      {
        delivery: { id: 1, orgId: "org-1", subscriptionId: 1, event: "candidate.created", payload: {}, status: "pending", attempts: 0 },
        subscription: { id: 1, url: "http://webhook.com", secret: "secret" },
      },
    ];
    db.limit.mockResolvedValue(pendingDeliveries);

    const { callProvider } = require("../../../../../common/outbound/call-provider");
    const { postSafeWebhook } = require("../../../../../common/outbound/safe-webhook-transport");

    callProvider.mockImplementation(async (desc: ProviderDescriptor, fn: () => Promise<unknown>) => {
      try {
        const res = await fn();
        return { ok: true, value: res, attempts: 1 };
      } catch (e) {
        return { ok: false, kind: "terminal", error: e as Error, attempts: 1 };
      }
    });
    postSafeWebhook.mockResolvedValue({ statusCode: 200, responseBody: "OK" });

    await service.sweep();

    expect(db.select).toHaveBeenCalled();
    expect(callProvider).toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledWith(hrWebhookDeliveries);
  });

  it("should calculate HMAC signature correctly", async () => {
    const pendingDeliveries = [
      {
        delivery: { id: 1, orgId: "org-1", subscriptionId: 1, event: "candidate.created", payload: { foo: "bar" }, status: "pending", attempts: 0 },
        subscription: { id: 1, url: "http://webhook.com", secret: "secret" },
      },
    ];
    db.limit.mockResolvedValue(pendingDeliveries);

    const { postSafeWebhook } = require("../../../../../common/outbound/safe-webhook-transport");
    postSafeWebhook.mockResolvedValue({ statusCode: 200, responseBody: "OK" });

    await service.sweep();

    // Verify the signature
    expect(postSafeWebhook).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"event":"candidate.created"'),
      expect.objectContaining({
        "X-StreamlineOS-Signature": expect.stringMatching(/^sha256=/),
      }),
      expect.any(Number),
      expect.any(Number)
    );
  });

  it("should mark delivery as dead after 5 attempts", async () => {
    const pendingDeliveries = [
        {
          delivery: { id: 1, orgId: "org-1", subscriptionId: 1, event: "candidate.created", payload: {}, status: "pending", attempts: 4 },
          subscription: { id: 1, url: "http://webhook.com", secret: "secret" },
        },
      ];
      db.limit.mockResolvedValue(pendingDeliveries);

      const { callProvider } = require("../../../../../common/outbound/call-provider");
      const { postSafeWebhook } = require("../../../../../common/outbound/safe-webhook-transport");

      callProvider.mockImplementation(async (desc: ProviderDescriptor, fn: () => Promise<unknown>) => {
        try {
          await fn();
          return { ok: true, attempts: 5 };
        } catch (e) {
          return { ok: false, kind: "terminal", error: e as Error, attempts: 5 };
        }
      });
      postSafeWebhook.mockResolvedValue({ statusCode: 500, responseBody: "Internal Server Error" });

      await service.sweep();

      expect(db.update).toHaveBeenCalledWith(hrWebhookDeliveries);
      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({
            status: "dead"
        })
      );
  });

});

describe("HrWebhookDispatchService — cross-tenant isolation", () => {
  let service: HrWebhookDispatchService;
  let db: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };

    const module = await Test.createTestingModule({
      providers: [
        HrWebhookDispatchService,
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    service = module.get<HrWebhookDispatchService>(HrWebhookDispatchService);
  });

  it("dispatches each delivery only to the subscription endpoint it was created for, not to a different org's webhook url (cross-tenant DENY)", async () => {
    const ORG_A_URL = "https://webhook.org-a.example.com";
    const ORG_B_URL = "https://webhook.org-b.example.com";

    db.limit.mockResolvedValue([
      {
        delivery: { id: 1, orgId: "org-a", subscriptionId: 1, event: "candidate.applied", payload: {}, status: "pending", attempts: 0, lastAttemptAt: null },
        subscription: { id: 1, orgId: "org-a", url: ORG_A_URL, secret: "secret-a" },
      },
    ]);

    const { callProvider } = require("../../../../../common/outbound/call-provider");
    const { postSafeWebhook } = require("../../../../../common/outbound/safe-webhook-transport");

    callProvider.mockImplementation(async (_desc: unknown, fn: () => Promise<unknown>) => {
      const res = await fn();
      return { ok: true, value: res, status: 200, body: "", attempts: 1 };
    });
    postSafeWebhook.mockResolvedValue({ statusCode: 200, responseBody: "OK" });

    await service.sweep();

    expect(postSafeWebhook).toHaveBeenCalledWith(
      ORG_A_URL,
      expect.any(String),
      expect.any(Object),
      expect.any(Number),
      expect.any(Number),
    );
    expect(postSafeWebhook).not.toHaveBeenCalledWith(
      ORG_B_URL,
      expect.any(String),
      expect.any(Object),
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("sends org-A's event payload to org-A's own webhook endpoint (same-tenant positive control)", async () => {
    const ORG_A_URL = "https://webhook.org-a.example.com";

    db.limit.mockResolvedValue([
      {
        delivery: { id: 2, orgId: "org-a", subscriptionId: 1, event: "candidate.hired", payload: { candidateId: 42 }, status: "pending", attempts: 0, lastAttemptAt: null },
        subscription: { id: 1, orgId: "org-a", url: ORG_A_URL, secret: "secret-a" },
      },
    ]);

    const { callProvider } = require("../../../../../common/outbound/call-provider");
    const { postSafeWebhook } = require("../../../../../common/outbound/safe-webhook-transport");

    callProvider.mockImplementation(async (_desc: unknown, fn: () => Promise<unknown>) => {
      const res = await fn();
      return { ok: true, value: res, status: 200, body: "", attempts: 1 };
    });
    postSafeWebhook.mockResolvedValue({ statusCode: 200, responseBody: "OK" });

    await service.sweep();

    expect(postSafeWebhook).toHaveBeenCalledWith(
      ORG_A_URL,
      expect.stringContaining('"event":"candidate.hired"'),
      expect.any(Object),
      expect.any(Number),
      expect.any(Number),
    );
  });
});
