/**
 * `resolveTier` is the gate in front of every paid feature and every quota:
 * `assertWithinLimit`, `canUseFeature`, the locked-module list and huddle capacity all read it.
 *
 * It used to be memoised in a per-process `Map` with a 30s TTL, and `bust(orgId)` deleted from that
 * one process's map. Every other API instance kept its own copy, so for up to 30 seconds after a
 * suspension, a downgrade or an expiry the fleet disagreed with itself about what the customer had
 * paid for — the instance that handled the webhook enforced the new plan and its siblings kept
 * selling the old one. Nothing about it was observable from the process that did the busting.
 *
 * These tests run two `PlanLimitsService` instances over one shared Redis, which is the shape the
 * deployment actually has, and pin that a bust on either one is seen by the other.
 */
import type { Redis } from "@upstash/redis";
import { CacheService } from "../../../common/cache/cache.service";
import { InMemoryRedis } from "../../../common/cache/in-memory-redis.test-double";
import type { Db } from "../../../db/drizzle.module";
import { PlanLimitsService } from "./plan-limits.service";

const ORG = "org-multi-instance";

/**
 * A database whose single `subscriptions` row can be changed between reads, counting every tenant
 * transaction that actually reached it. `queryTier` opens exactly one per miss (`withTenant` then
 * issues the GUC statement and the SELECT inside it), so the transaction count is the miss count.
 */
function makeDb(initial: Record<string, unknown>) {
  const state = { row: initial, reads: 0 };
  const db = {
    execute: jest.fn().mockImplementation(() => Promise.resolve([state.row])),
    transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      state.reads += 1;
      return fn(db);
    }),
  };
  return { db: db as unknown as Db, state };
}

const PAID = { plan: "PROFESSIONAL", status: "ACTIVE", trial_ends_at: null, created_at: new Date() };
const CANCELLED = { plan: "PROFESSIONAL", status: "CANCELLED", trial_ends_at: null, created_at: new Date() };

function instance(db: Db, redis: InMemoryRedis): PlanLimitsService {
  return new PlanLimitsService(db, new CacheService(redis as unknown as Redis), null);
}

describe("PlanLimitsService — the resolved tier is fleet-wide, not per-process", () => {
  it("serves a sibling instance the same tier without re-querying", async () => {
    const redis = new InMemoryRedis();
    const { db, state } = makeDb(PAID);
    const a = instance(db, redis);
    const b = instance(db, redis);

    await expect(a.resolveTier(ORG)).resolves.toEqual({ tier: "PAID", plan: "PROFESSIONAL" });
    await expect(b.resolveTier(ORG)).resolves.toEqual({ tier: "PAID", plan: "PROFESSIONAL" });

    expect(state.reads).toBe(1);
  });

  it("makes a bust on one instance visible to every other instance", async () => {
    const redis = new InMemoryRedis();
    const { db, state } = makeDb(PAID);
    const a = instance(db, redis);
    const b = instance(db, redis);

    await a.resolveTier(ORG);
    await b.resolveTier(ORG);

    // The webhook lands on instance A; the subscription is cancelled.
    state.row = CANCELLED;
    await a.bust(ORG);

    // Instance B must now see the cancellation, not its own memo of the paid plan.
    await expect(b.resolveTier(ORG)).resolves.toEqual({ tier: "FREE", plan: "FREE" });
  });

  it("makes a bust on a sibling visible to the instance that first cached it", async () => {
    const redis = new InMemoryRedis();
    const { db, state } = makeDb(PAID);
    const a = instance(db, redis);
    const b = instance(db, redis);

    await a.resolveTier(ORG);
    state.row = CANCELLED;
    await b.bust(ORG);

    await expect(a.resolveTier(ORG)).resolves.toEqual({ tier: "FREE", plan: "FREE" });
  });

  it("still holds the tier for a caller that did not bust, so the cache is a cache", async () => {
    const redis = new InMemoryRedis();
    const { db, state } = makeDb(PAID);
    const a = instance(db, redis);

    await a.resolveTier(ORG);
    state.row = CANCELLED;

    await expect(a.resolveTier(ORG)).resolves.toEqual({ tier: "PAID", plan: "PROFESSIONAL" });
    expect(state.reads).toBe(1);
  });

  it("keeps one organization's bust off another organization's entry", async () => {
    const redis = new InMemoryRedis();
    const { db, state } = makeDb(PAID);
    const a = instance(db, redis);

    await a.resolveTier(ORG);
    await a.resolveTier("org-other");
    expect(state.reads).toBe(2);

    await a.bust(ORG);

    await a.resolveTier("org-other");
    expect(state.reads).toBe(2);
  });
});

describe("PlanLimitsService — cache unavailable: fails closed, never open", () => {
  it("propagates a Redis error rather than serving a FREE tier that might be stale PAID", async () => {
    const { db } = makeDb(PAID);
    const brokenCache = {
      cached: jest.fn().mockRejectedValue(new Error("Redis ECONNREFUSED")),
      invalidate: jest.fn(),
      set: jest.fn(),
      get: jest.fn(),
    };
    const svc = new (PlanLimitsService as unknown as new (
      db: typeof db,
      cache: typeof brokenCache,
      notifications: null,
    ) => PlanLimitsService)(db, brokenCache as never, null);

    await expect(svc.resolveTier(ORG)).rejects.toThrow("Redis ECONNREFUSED");
  });

  it("propagates a Redis error rather than serving a PAID tier that might be stale FREE", async () => {
    const { db } = makeDb(CANCELLED);
    const brokenCache = {
      cached: jest.fn().mockRejectedValue(new Error("Redis unavailable")),
      invalidate: jest.fn(),
      set: jest.fn(),
      get: jest.fn(),
    };
    const svc = new (PlanLimitsService as unknown as new (
      db: typeof db,
      cache: typeof brokenCache,
      notifications: null,
    ) => PlanLimitsService)(db, brokenCache as never, null);

    await expect(svc.resolveTier(ORG)).rejects.toThrow("Redis unavailable");
  });

  it("a bust on a cancelled subscription invalidates both the tier and the entitlements key", async () => {
    const redis = new InMemoryRedis();
    const { db } = makeDb(CANCELLED);
    const a = instance(db, redis);

    await redis.set(`billing:tier:${ORG}`, JSON.stringify({ tier: "PAID", plan: "PROFESSIONAL" }), { ex: 30 });
    await redis.set(`billing:entitlements:${ORG}`, JSON.stringify({ tier: "PAID" }), { ex: 60 });

    await a.bust(ORG);

    expect(await redis.get(`billing:tier:${ORG}`)).toBeNull();
    expect(await redis.get(`billing:entitlements:${ORG}`)).toBeNull();
  });
});

describe("PlanLimitsService — current_period_end enforcement (fake clock)", () => {
  it("serves PAID tier when the period ends in the future", async () => {
    const redis = new InMemoryRedis();
    const futureEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const { db } = makeDb({ ...PAID, current_period_end: futureEnd });
    const svc = instance(db, redis);

    await expect(svc.resolveTier(ORG)).resolves.toEqual({ tier: "PAID", plan: "PROFESSIONAL" });
  });

  it("serves FREE tier when the period has ended", async () => {
    const redis = new InMemoryRedis();
    const pastEnd = new Date(Date.now() - 86_400_000).toISOString();
    const { db } = makeDb({ ...PAID, current_period_end: pastEnd });
    const svc = instance(db, redis);

    await expect(svc.resolveTier(ORG)).resolves.toEqual({ tier: "FREE", plan: "FREE" });
  });

  it("serves PAID tier when current_period_end is null (no period set, legacy row)", async () => {
    const redis = new InMemoryRedis();
    const { db } = makeDb({ ...PAID, current_period_end: null });
    const svc = instance(db, redis);

    await expect(svc.resolveTier(ORG)).resolves.toEqual({ tier: "PAID", plan: "PROFESSIONAL" });
  });

  it("a second API instance sees the expired tier after the first one busts it", async () => {
    const redis = new InMemoryRedis();
    const futureEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const { db, state } = makeDb({ ...PAID, current_period_end: futureEnd });
    const a = instance(db, redis);
    const b = instance(db, redis);

    await a.resolveTier(ORG);
    await b.resolveTier(ORG);

    state.row = { ...CANCELLED, current_period_end: new Date(Date.now() - 86_400_000).toISOString() };
    await a.bust(ORG);

    await expect(b.resolveTier(ORG)).resolves.toEqual({ tier: "FREE", plan: "FREE" });
  });
});
