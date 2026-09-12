import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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

    it("keeps the paid tier while PAST_DUE, because dunning downgrades by cancelling at D+14", async () => {
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "STARTER", status: "PAST_DUE", trial_ends_at: null }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "PAID", plan: "STARTER" });
    });

    it("drops to FREE once dunning cancels the subscription, which is what ends the grace period", async () => {
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "STARTER", status: "CANCELLED", trial_ends_at: null }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "FREE", plan: "FREE" });
    });

    it("returns ENTERPRISE for active ENTERPRISE subscription", async () => {
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "ENTERPRISE", status: "ACTIVE", trial_ends_at: null }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "ENTERPRISE", plan: "ENTERPRISE" });
    });

    it("returns FREE when ACTIVE subscription has a past current_period_end", async () => {
      const pastPeriodEnd = new Date(Date.now() - 86_400_000).toISOString();
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "STARTER", status: "ACTIVE", trial_ends_at: null, current_period_end: pastPeriodEnd }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "FREE", plan: "FREE" });
    });

    it("returns PAID when ACTIVE subscription has a future current_period_end", async () => {
      const futurePeriodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "PROFESSIONAL", status: "ACTIVE", trial_ends_at: null, current_period_end: futurePeriodEnd }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "PAID", plan: "PROFESSIONAL" });
    });

    it("returns PAID when ACTIVE subscription has no current_period_end (legacy row without period)", async () => {
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "STARTER", status: "ACTIVE", trial_ends_at: null, current_period_end: null }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "PAID", plan: "STARTER" });
    });

    it("keeps PAID tier while PAST_DUE regardless of current_period_end, because dunning cancels at D+14", async () => {
      const pastPeriodEnd = new Date(Date.now() - 86_400_000).toISOString();
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "PROFESSIONAL", status: "PAST_DUE", trial_ends_at: null, current_period_end: pastPeriodEnd }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "PAID", plan: "PROFESSIONAL" });
    });

    it("annual subscription with future 12-month period end is still PAID", async () => {
      const annualEnd = new Date(Date.now() + 365 * 86_400_000).toISOString();
      mockDb = makeDb({
        execute: jest.fn().mockResolvedValue([{ plan: "STARTER", status: "ACTIVE", trial_ends_at: null, current_period_end: annualEnd }]),
      });
      service = await build(mockDb);
      const result = await service.resolveTier("org1");
      expect(result).toEqual({ tier: "PAID", plan: "STARTER" });
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

    it("counts through the caller's executor for a non-member key, so a quota lock still covers the read", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }]),
      });
      const txExecute = jest.fn().mockResolvedValue([{ count: 1 }]);
      service = await build(mockDb);

      await expect(
        service.assertWithinLimit("org1", "projects", 1, { execute: txExecute } as never),
      ).resolves.toBeUndefined();

      expect(txExecute).toHaveBeenCalledTimes(1);
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
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

  describe("assertWithinLimit — chatChannels excludes entity-linked rows", () => {
    const FREE_TIER = [{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }];

    function renderedSql(execute: jest.Mock, callIndex: number): string {
      const arg: unknown = execute.mock.calls[callIndex]?.[0];
      if (!(arg instanceof SQL))
        throw new Error(`call ${callIndex} did not receive a drizzle SQL statement`);
      return new PgDialect().sqlToQuery(arg).sql;
    }

    it("counts only channels with no entity_id, so a project channel does not consume the quota", async () => {
      const execute = jest
        .fn()
        .mockResolvedValueOnce(FREE_TIER)
        .mockResolvedValueOnce([{ count: 0 }]);
      service = await build(makeDb({ execute }));

      await expect(service.assertWithinLimit("org1", "chatChannels", 1)).resolves.toBeUndefined();
      const counted = renderedSql(execute, 1);
      expect(counted).toContain("chat_channels");
      expect(counted).toContain("entity_id IS NULL");
    });

    it("still refuses a non-entity channel once the counted rows reach the FREE limit", async () => {
      const execute = jest
        .fn()
        .mockResolvedValueOnce(FREE_TIER)
        .mockResolvedValueOnce([{ count: 1 }]);
      service = await build(makeDb({ execute }));

      await expect(service.assertWithinLimit("org1", "chatChannels", 1)).rejects.toBeInstanceOf(
        PaymentRequiredException,
      );
    });

    it("excludes entity-linked rows from the bulk usage projection too", async () => {
      const USAGE_ROW = {
        members: 1, projects: 0, kbPages: 0, chatChannels: 0, crmLeads: 0, crmContacts: 0,
        crmDeals: 0, supportTickets: 0, automations: 0, signEnvelopes: 0, surveys: 0,
        acctInvoices: 0, hrCandidates: 0, hrJobPostings: 0,
      };
      const execute = jest
        .fn()
        .mockResolvedValueOnce(FREE_TIER)
        .mockResolvedValueOnce([USAGE_ROW]);
      service = await build(makeDb({ execute }));

      await service.getEntitlements("org1");
      const usageSql = renderedSql(execute, 1);
      expect(usageSql).toContain("chat_channels");
      expect(usageSql).toContain("entity_id IS NULL");
    });
  });

  describe("assertWithinLimit — concurrent seat race produces a correct total", () => {
    it("blocks the second writer when the seat count has advanced to the limit", async () => {
      const FREE_TIER = [{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }];
      const dbFirst = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce(FREE_TIER)
          .mockResolvedValueOnce([{ count: 4 }]),
      });
      const dbSecond = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce(FREE_TIER)
          .mockResolvedValueOnce([{ count: 5 }]),
      });
      const svcFirst = await build(dbFirst);
      const svcSecond = await build(dbSecond);

      const resultFirst = svcFirst.assertWithinLimit("org1", "members", 1);
      const resultSecond = svcSecond.assertWithinLimit("org1", "members", 1);

      const [r1, r2] = await Promise.allSettled([resultFirst, resultSecond]);

      expect(r1.status).toBe("fulfilled");
      expect(r2.status).toBe("rejected");
      if (r2.status === "rejected")
        expect(r2.reason).toBeInstanceOf(PaymentRequiredException);
    });

    it("never grants the same seat twice: a caller reading the committed count at limit is blocked", async () => {
      const FREE_TIER = [{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }];
      const dbAtLimit = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce(FREE_TIER)
          .mockResolvedValueOnce([{ count: 5 }]),
      });
      const svc = await build(dbAtLimit);

      await expect(svc.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(
        PaymentRequiredException,
      );
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

  describe("assertWithinLimit — seat count includes pending invitations", () => {
    it("blocks a new invite when active members plus live pending invitations reach the limit", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 5 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(PaymentRequiredException);
    });

    it("allows a new invite once the count drops when a pending invitation expires", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 4 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).resolves.toBeUndefined();
    });

    it("allows a new invite once the count drops when a pending invitation is cancelled", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 3 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).resolves.toBeUndefined();
    });

    it("an organization_people row without organization_members does not consume a seat — seatCount only counts members", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 0 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).resolves.toBeUndefined();
    });
  });

  describe("assertWithinLimit — suspension does not free a seat", () => {
    it("a suspended member still occupies a seat (MEMBER_SUSPENDED delta = 0)", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 5 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(PaymentRequiredException);
    });

    it("a reactivated member was never unoccupied — the seat count does not jump", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 5 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 0)).resolves.toBeUndefined();
    });

    it("removal (DELETE of organization_members row) drops the live count and allows re-invitation", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 4 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).resolves.toBeUndefined();
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