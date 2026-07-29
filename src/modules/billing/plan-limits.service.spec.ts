import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { PlanLimitsService } from "./plan-limits.service";

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

    it("throws ForbiddenException when used + increment exceeds limit", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 5 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("throws ForbiddenException when used equals limit and increment is 1", async () => {
      mockDb = makeDb({
        execute: jest
          .fn()
          .mockResolvedValueOnce([{ plan: "FREE", status: "ACTIVE", trial_ends_at: null }])
          .mockResolvedValueOnce([{ count: 5 }]),
      });
      service = await build(mockDb);
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(ForbiddenException);
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
      await expect(service.assertWithinLimit("org1", "members", 1)).rejects.toBeInstanceOf(ForbiddenException);
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
      await expect(service.assertWithinLimit("org1", "members", 0)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});