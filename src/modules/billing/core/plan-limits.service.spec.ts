import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { PaymentRequiredException } from "../../../common/http/api-exceptions";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { PlanLimitsService } from "./plan-limits.service";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

function makeDb(overrides: Record<string, unknown> = {}) {
  return {
    execute: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeCache(): CacheService {
  return {
    cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    set: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;
}

describe("PlanLimitsService", () => {
  let service: PlanLimitsService;
  let mockDb: ReturnType<typeof makeDb>;

  async function build(db: ReturnType<typeof makeDb>) {
    const module = await Test.createTestingModule({
      providers: [
        PlanLimitsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: makeCache() },
      ],
    }).compile();
    return module.get(PlanLimitsService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("resolveTier", () => {
    it("returns FREE when no subscription row exists", async () => {
      mockDb = makeDb({ execute: jest.fn().mockResolvedValue([]) });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "FREE", plan: "FREE" });
    });

    it("returns FREE when subscription status is EXPIRED", async () => {
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "STARTER", status: "EXPIRED", trial_ends_at: null }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "FREE", plan: "FREE" });
    });

    it("returns FREE when subscription status is CANCELLED", async () => {
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "PROFESSIONAL", status: "CANCELLED", trial_ends_at: null }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "FREE", plan: "FREE" });
    });

    it("returns FREE when TRIAL has expired", async () => {
      const pastDate = new Date(Date.now() - 86_400_000).toISOString();
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "STARTER", status: "TRIAL", trial_ends_at: pastDate }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "FREE", plan: "FREE" });
    });

    it("returns PAID/STARTER when TRIAL is still active", async () => {
      const futureDate = new Date(Date.now() + 86_400_000 * 7).toISOString();
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "STARTER", status: "TRIAL", trial_ends_at: futureDate }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "PAID", plan: "STARTER" });
    });

    it("returns PAID/STARTER for active STARTER subscription", async () => {
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "STARTER", status: "ACTIVE", trial_ends_at: null }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "PAID", plan: "STARTER" });
    });

    it("returns ENTERPRISE for active ENTERPRISE subscription", async () => {
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "ENTERPRISE", status: "ACTIVE", trial_ends_at: null }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "ENTERPRISE", plan: "ENTERPRISE" });
    });
  });

  describe("assertWithinLimit", () => {
    it("does not throw when used is below limit", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 3 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).resolves.toBeUndefined();
    });

    it("throws PaymentRequiredException when used + increment exceeds limit", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 5 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(PaymentRequiredException);
    });

    it("throws PaymentRequiredException when used equals limit and increment is 1", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 5 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(PaymentRequiredException);
    });

    it("does not throw for null limit (unlimited plan)", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "PROFESSIONAL", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 999999 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "projects", 1)).resolves.toBeUndefined();
    });

    it("error message includes plan name and human label", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 5 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toThrow(
        /Free.*members/,
      );
    });

    it("nests quota facts under details, which is the only field the error envelope forwards", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 5 }]),
      });
      service = await build(mockDb);
      const error = await service
        .assertWithinLimit("org1", "members", 1)
        .then(() => null)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(PaymentRequiredException);
      expect((error as PaymentRequiredException).getResponse()).toMatchObject({
        code: "QUOTA_EXCEEDED",
        details: { limitKey: "members", used: 5, limit: 5, upgradePath: "/settings/billing" },
      });
    });

    it("uses negotiated enterprise seats when asserting members limit", async () => {
      mockDb = makeDb({
        execute: jest
          // resolveTier
          .fn()
          .mockResolvedValueOnce([{ plan: "ENTERPRISE", status: "ACTIVE", trial_ends_at: null }])
          // fetchNegotiatedSeats
          .mockResolvedValueOnce([{ negotiated_seats: 1200 }])
          // fetchCount members
          .mockResolvedValueOnce([{ count: 1200 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toThrow(
        /Enterprise.*members/,
      );
    });

    it("allows members under negotiated enterprise seats", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "ENTERPRISE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ negotiated_seats: 1200 }])
          .mockResolvedValueOnce([{ count: 500 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).resolves.toBeUndefined();
    });

    it("blocks when combined members + pending invitations count reaches the limit", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 5 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(PaymentRequiredException);
    });

    it("allows accept (increment 0) when invitation's slot is within the limit", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 5 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 0)).resolves.toBeUndefined();
    });

    it("blocks accept (increment 0) when combined count strictly exceeds the limit", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 6 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 0)).rejects.toBeInstanceOf(PaymentRequiredException);
    });
  });

  describe("assertWithinLimit — a count that cannot be computed refuses the write", () => {
    const FREE_TIER = [{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }];

    function countReturning(countRows: unknown) {
      return makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce(FREE_TIER)
          .mockImplementationOnce(() =>
            countRows instanceof Error ? Promise.reject(countRows) : Promise.resolve(countRows),
          ),
      });
    }

    it("refuses when the count query throws", async () => {
      service = await build(countReturning(new Error("connection terminated unexpectedly")));
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it("refuses when the count query returns no rows", async () => {
      service = await build(countReturning([]));
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it("refuses when the count column is null", async () => {
      service = await build(countReturning([{ count: null }]));
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it("refuses when the count column is absent from the row", async () => {
      service = await build(countReturning([{ something_else: 3 }]));
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it("refuses when the count is not a number", async () => {
      service = await build(countReturning([{ count: "not-a-number" }]));
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it("refuses every limited resource, not only members", async () => {
      service = await build(countReturning([]));
      await expect(service.assertWithinLimit("org1", "kbPages", 1)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it("says which count could not be determined", async () => {
      service = await build(countReturning(new Error("57014 canceling statement due to statement timeout")));
      await expect(service.assertWithinLimit("org1", "kbPages", 1)).rejects.toThrow(
        /knowledge base pages count could not be determined/,
      );
    });

    it("reports the failure rather than swallowing it", async () => {
      const logged: unknown[] = [];
      service = await build(countReturning(new Error("connection terminated unexpectedly")));
      jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation((...args: unknown[]) => void logged.push(args));

      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(JSON.stringify(logged)).toContain("connection terminated unexpectedly");
    });

    it("still refuses when the count is unavailable but the tier resolves to a paid plan", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "STARTER", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it("does not consult the count at all when the plan limit is unlimited", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "PROFESSIONAL", status: "ACTIVE", trial_ends_at: null }])
          .mockRejectedValueOnce(new Error("connection terminated unexpectedly")),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "projects", 1)).resolves.toBeUndefined();
    });
  });

  describe("getEntitlements — usage stays visible while it is computable", () => {
    const USAGE_ROW = {
      members: 3,
      projects: 1,
      kbPages: 4,
      chatChannels: 1,
      crmLeads: 0,
      crmContacts: 0,
      crmDeals: 0,
      supportTickets: 0,
      automations: 0,
      signEnvelopes: 0,
      surveys: 0,
      acctInvoices: 0,
      hrCandidates: 0,
      hrJobPostings: 0,
    };

    it("reports what has been consumed against each limit", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([USAGE_ROW]),
      });
      service = await build(mockDb);
      const entitlements = await service.getEntitlements("org1");

      expect(entitlements.plan).toBe("FREE");
      expect(entitlements.seatLimit).toBe(5);
      expect(entitlements.limits.members).toEqual({ limit: 5, used: 3 });
      expect(entitlements.limits.kbPages).toEqual({ limit: 10, used: 4 });
      expect(entitlements.limits.projects).toEqual({ limit: 2, used: 1 });
    });

    it("refuses rather than reporting zero usage when the usage query throws", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockRejectedValueOnce(new Error("connection terminated unexpectedly")),
      });
      service = await build(mockDb);
      await expect(service.getEntitlements("org1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it("refuses rather than reporting zero usage when a count column is missing", async () => {
      const { kbPages: _dropped, ...withoutKbPages } = USAGE_ROW;
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([withoutKbPages]),
      });
      service = await build(mockDb);
      await expect(service.getEntitlements("org1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it("refuses rather than reporting zero usage when the usage query returns no rows", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([]),
      });
      service = await build(mockDb);
      await expect(service.getEntitlements("org1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe("getEntitlements — Redis outage: fails closed, never open", () => {
    async function buildWithCache(db: ReturnType<typeof makeDb>, cacheOverride: Partial<CacheService>) {
      const module = await Test.createTestingModule({
        providers: [
          PlanLimitsService,
          { provide: DRIZZLE, useValue: db },
          { provide: CacheService, useValue: { ...makeCache(), ...cacheOverride } },
        ],
      }).compile();
      return module.get(PlanLimitsService);
    }

    it("propagates a cache-layer failure rather than returning empty entitlements", async () => {
      const db = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }]),
      });
      const svc = await buildWithCache(db, {
        cached: jest.fn().mockRejectedValue(new Error("Redis ECONNREFUSED")),
      });
      await expect(svc.getEntitlements("org1")).rejects.toThrow("Redis ECONNREFUSED");
    });

    it("still enforces limits when Redis is unavailable and the cache falls through to DB", async () => {
      const USAGE_ROW = {
        members: 5, projects: 2, kbPages: 10, chatChannels: 0, crmLeads: 0, crmContacts: 0,
        crmDeals: 0, supportTickets: 0, automations: 0, signEnvelopes: 0, surveys: 0,
        acctInvoices: 0, hrCandidates: 0, hrJobPostings: 0,
      };
      const db = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([USAGE_ROW]),
      });
      const svc = await buildWithCache(db, {
        cached: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
      });
      const entitlements = await svc.getEntitlements("org1");
      expect(entitlements.limits.members).toEqual({ limit: 5, used: 5 });
      expect(entitlements.plan).toBe("FREE");
    });
  });
});