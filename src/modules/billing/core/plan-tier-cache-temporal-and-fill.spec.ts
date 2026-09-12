/**
 * AB-08 cache matrix for the two billing caches: `billing:tier:${orgId}` (30s) and
 * `billing:entitlements:${orgId}` (60s).
 *
 * The sibling multi-instance suite proves a bust crosses instances. It cannot prove any of the
 * four cases below, for two reasons that were defects in the shared Redis double rather than in
 * the service: the double ignored `ex` entirely, so no TTL could ever elapse and temporal expiry
 * was untestable; and its `del` took one key while `CacheService.invalidate` passes two — the
 * entry AND the fill lease — so the lease survived every simulated bust and the fill-after-bust
 * guard was never exercised. Both are fixed in the double; these are the tests that needed them.
 */
import type { Redis } from "@upstash/redis";
import { CacheService } from "../../../common/cache/cache.service";
import { InMemoryRedis } from "../../../common/cache/in-memory-redis.test-double";
import { PlanLimitsService } from "./plan-limits.service";
import { makeTierDb, TIER_CANCELLED, TIER_PAID } from "./plan-tier-db.test-double";

const ORG_A = "org-ab08-a";
const ORG_B = "org-ab08-b";
const TIER_KEY_A = `billing:tier:${ORG_A}`;
const TIER_TTL_SECONDS = 30;
const JITTER_LOW = 0.85;
const JITTER_HIGH = 1.15;

function instance(db: ReturnType<typeof makeTierDb>["db"], redis: InMemoryRedis): PlanLimitsService {
  return new PlanLimitsService(db, new CacheService(redis as unknown as Redis), null);
}

async function waitForLease(redis: InMemoryRedis, key: string): Promise<void> {
  for (let tick = 0; tick < 200; tick++) {
    if (redis.keys().includes(`cache:fill-lease:${key}`)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`fill lease for ${key} was never acquired`);
}

describe("AB-08 — temporal expiry: the entry ages out with no writer involved", () => {
  it("re-queries after the TTL elapses, having served the cached tier until then", async () => {
    const redis = new InMemoryRedis(false, { honourExpiry: true });
    const { db, state } = makeTierDb(TIER_PAID);
    const service = instance(db, redis);

    await service.resolveTier(ORG_A);
    await service.resolveTier(ORG_A);
    expect(state.reads).toBe(1);

    redis.advanceSeconds(TIER_TTL_SECONDS * JITTER_HIGH + 1);
    await service.resolveTier(ORG_A);

    expect(state.reads).toBe(2);
  });

  it("writes a TTL inside the jittered band, so a fleet-wide expiry never lands in one spike", async () => {
    const observed: number[] = [];
    for (let attempt = 0; attempt < 25; attempt++) {
      const redis = new InMemoryRedis(false, { honourExpiry: true });
      const { db } = makeTierDb(TIER_PAID);
      await instance(db, redis).resolveTier(ORG_A);
      const ttl = redis.ttlSeconds(TIER_KEY_A);
      expect(ttl).not.toBeNull();
      observed.push(ttl as number);
    }

    for (const ttl of observed) {
      expect(ttl).toBeGreaterThanOrEqual(TIER_TTL_SECONDS * JITTER_LOW);
      expect(ttl).toBeLessThanOrEqual(TIER_TTL_SECONDS * JITTER_HIGH);
    }
    expect(new Set(observed).size).toBeGreaterThan(1);
  });

  it("does not expire early: the entry still answers just before its floor", async () => {
    const redis = new InMemoryRedis(false, { honourExpiry: true });
    const { db, state } = makeTierDb(TIER_PAID);
    const service = instance(db, redis);

    await service.resolveTier(ORG_A);
    redis.advanceSeconds(TIER_TTL_SECONDS * JITTER_LOW - 1);
    await service.resolveTier(ORG_A);

    expect(state.reads).toBe(1);
  });
});

describe("AB-08 — fill after bust: a fill that started before the bust must not install its value", () => {
  it("drops the value of a fill that was in flight when the tier was busted", async () => {
    const redis = new InMemoryRedis(false, { honourExpiry: true });
    const { db, state, release } = makeTierDb(TIER_PAID, { gated: true });
    const service = instance(db, redis);

    const inFlight = service.resolveTier(ORG_A);
    await waitForLease(redis, TIER_KEY_A);
    await service.bust(ORG_A);
    release();
    await expect(inFlight).resolves.toEqual({ tier: "PAID", plan: "PROFESSIONAL" });

    expect(await redis.get(TIER_KEY_A)).toBeNull();

    state.row = TIER_CANCELLED;
    await expect(service.resolveTier(ORG_A)).resolves.toEqual({ tier: "FREE", plan: "FREE" });
  });

  it("is not vacuous: without the lease deletion the stale value IS installed", async () => {
    class LeaseDeafRedis extends InMemoryRedis {
      override del(...keys: string[]): Promise<number> {
        return super.del(...keys.filter((key) => !key.startsWith("cache:fill-lease:")));
      }
    }

    const redis = new LeaseDeafRedis(false, { honourExpiry: true });
    const { db, release } = makeTierDb(TIER_PAID, { gated: true });
    const service = instance(db, redis);

    const inFlight = service.resolveTier(ORG_A);
    await waitForLease(redis, TIER_KEY_A);
    await service.bust(ORG_A);
    release();
    await inFlight;

    expect(await redis.get(TIER_KEY_A)).not.toBeNull();
  });

  it("busts the entitlements key alongside the tier, so neither survives the other", async () => {
    const redis = new InMemoryRedis(false, { honourExpiry: true });
    const { db } = makeTierDb(TIER_PAID);
    const service = instance(db, redis);

    await service.resolveTier(ORG_A);
    await redis.set(`billing:entitlements:${ORG_A}`, { modules: [] }, { ex: 60 });
    await service.bust(ORG_A);

    expect(await redis.get(TIER_KEY_A)).toBeNull();
    expect(await redis.get(`billing:entitlements:${ORG_A}`)).toBeNull();
  });
});

describe("AB-08 — cache failure and organization switching", () => {
  it("answers from the database when Redis is unreachable, behind a memo bounded to one second", async () => {
    class DeadRedis extends InMemoryRedis {
      override get<T>(): Promise<T | null> {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
    }

    const { db, state } = makeTierDb(TIER_PAID);
    const service = instance(db, new DeadRedis());

    await expect(service.resolveTier(ORG_A)).resolves.toEqual({ tier: "PAID", plan: "PROFESSIONAL" });

    state.row = TIER_CANCELLED;
    await expect(service.resolveTier(ORG_A)).resolves.toEqual({ tier: "PAID", plan: "PROFESSIONAL" });
    expect(state.reads).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(service.resolveTier(ORG_A)).resolves.toEqual({ tier: "FREE", plan: "FREE" });
    expect(state.reads).toBe(2);
  });

  it("never answers one organization from another organization's entry", async () => {
    const redis = new InMemoryRedis(false, { honourExpiry: true });
    const paid = makeTierDb(TIER_PAID);
    const free = makeTierDb(TIER_CANCELLED);
    const paidService = instance(paid.db, redis);
    const freeService = instance(free.db, redis);

    await expect(paidService.resolveTier(ORG_A)).resolves.toEqual({ tier: "PAID", plan: "PROFESSIONAL" });
    await expect(freeService.resolveTier(ORG_B)).resolves.toEqual({ tier: "FREE", plan: "FREE" });

    await paidService.bust(ORG_A);
    expect(await redis.get(`billing:tier:${ORG_B}`)).not.toBeNull();
  });

  it("does not let a fill for the previous organization answer the one switched to", async () => {
    const redis = new InMemoryRedis(false, { honourExpiry: true });
    const previous = makeTierDb(TIER_PAID, { gated: true });
    const current = makeTierDb(TIER_CANCELLED);

    const stalePrevious = instance(previous.db, redis).resolveTier(ORG_A);
    await Promise.resolve();

    await expect(instance(current.db, redis).resolveTier(ORG_B)).resolves.toEqual({
      tier: "FREE",
      plan: "FREE",
    });

    previous.release();
    await stalePrevious;
    expect(await redis.get(`billing:tier:${ORG_B}`)).toEqual({ tier: "FREE", plan: "FREE" });
  });
});
