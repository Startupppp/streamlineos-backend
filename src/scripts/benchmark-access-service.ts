/**
 * In-process authorization benchmark for p99-in-process-authorization (≤100 µs CPU).
 *
 * Constructs the real AccessService with minimal stub dependencies, primes its
 * in-process caches (versionCache, permsCache, membershipAccessCache,
 * deniedModulesCache) so the warm path hits NO I/O, then drives
 * resolveUserPermissions in a tight loop measuring only CPU time via
 * process.cpuUsage().
 *
 * "Do NOT reimplement applyUniversalGrants or stripDeniedModules" — this script
 * reaches them through the real public entry point (resolveUserPermissions) on a
 * real AccessService instance. The stub dependencies are never called on the warm
 * path; any accidental cold-path call throws immediately, proving the warm path
 * never reaches I/O.
 *
 * Run: node --env-file=.env -r ts-node/register/transpile-only src/scripts/benchmark-access-service.ts
 * Or:  pnpm -C backend auth:benchmark
 *
 * Writes .auth-benchmark-results.json.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

process.chdir(resolve(__dirname, "../.."));

import { AccessService } from "../modules/access/access.service";
import { AccessVersionCache } from "../modules/access/access-version-cache";
import { membershipCacheKey } from "../modules/access/access-permission.resolver";
import type { CacheService } from "../common/cache/cache.service";
import type { EntitlementsService } from "../modules/access/entitlements.service";
import type { MfaPolicyService } from "../modules/access/mfa-policy.service";
import type { Db } from "../db/drizzle.module";

const OUT = resolve(process.cwd(), ".auth-benchmark-results.json");
const ITERATIONS = 50_000;
const WARMUP = 5_000;
const BATCH_SIZE = 2_000;
const BATCHES = 100;
const WALL_SAMPLES = 20_000;

function measureCpuClockGranularityUs(): number {
  const deltas: number[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const before = process.cpuUsage();
    let delta = 0;
    while (delta === 0) {
      const after = process.cpuUsage(before);
      delta = after.user + after.system;
    }
    deltas.push(delta);
  }
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] ?? 0;
}

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");

function never(name: string): never {
  throw new Error(
    `[BENCHMARK INTEGRITY] stub '${name}' was called on the warm path — the in-process cache was not primed correctly`,
  );
}

const mockDb = new Proxy(
  {},
  { get: (_, p) => never(`db.${String(p)}`) },
) as unknown as Db;

const mockCache: CacheService = {
  get: () => never("cache.get"),
  set: () => never("cache.set"),
  invalidate: () => never("cache.invalidate"),
  invalidateForOrg: () => never("cache.invalidateForOrg"),
  invalidateNamespace: () => never("cache.invalidateNamespace"),
  getOrSet: () => never("cache.getOrSet"),
  cachedVersioned: () => never("cache.cachedVersioned"),
} as unknown as CacheService;

const mockEntitlements: EntitlementsService = {
  isModuleEnabled: () => never("entitlements.isModuleEnabled"),
  getOrgEntitlements: () => never("entitlements.getOrgEntitlements"),
} as unknown as EntitlementsService;

const mockMfa: MfaPolicyService = {
  isMfaRequired: () => never("mfa.isMfaRequired"),
} as unknown as MfaPolicyService;

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

async function run() {
  if (SELF_TEST) {
    console.log("Verifying that stub dependencies throw on the cold path...");
    try {
      mockDb.query;
      console.error("SELF-TEST FAIL: stub db should throw on access");
      process.exitCode = 1;
    } catch {
      console.log(
        "SELF-TEST PASS: stub throws on cold-path access — benchmark integrity guard works",
      );
    }
    return;
  }

  console.log("Constructing AccessService with stub dependencies...");
  const mockVersionCache = new AccessVersionCache(mockDb, mockCache);
  const svc = new AccessService(
    mockDb,
    mockCache,
    mockEntitlements,
    mockMfa,
    mockVersionCache,
  ) as AccessService & Record<string, unknown>;

  const orgId = "bench-org-a1b2c3d4";
  const userId = "bench-user-e5f6g7h8";
  const version = 42;
  const now = Date.now();
  const expiresAt = now + 300_000;

  console.log("Priming in-process caches...");

  const perms: Record<string, string> = {};
  for (const key of [
    "home:dashboard:view", "home:announcements:view", "home:directory:view",
    "chat:read", "chat:write", "mail:read", "calendar:view", "calendar:create",
    "build:view", "build:tickets:view", "build:tickets:create",
    "hr:view", "self:profile:view", "self:leave:view", "self:payslips:view",
    "kb:read", "notifications:view",
  ]) perms[key] = "all";

  const versionCacheFields: Record<string, unknown> = { ...mockVersionCache };
  versionCacheFields["versionCache"] = new Map([[orgId, { version, expiresAt }]]);
  Object.assign(mockVersionCache, { versionCache: versionCacheFields["versionCache"] });

  const permsKey = `${orgId}:${userId}:${version}`;
  (svc as Record<string, unknown>).permsCache = new Map([
    [permsKey, { perms, expiresAt }],
  ]);

  const memberKey = membershipCacheKey(orgId, userId, version);
  (svc as Record<string, unknown>).membershipAccessCache = new Map([
    [memberKey, { active: true, isOwnerOrAdmin: false, expiresAt }],
  ]);

  (svc as Record<string, unknown>).deniedModulesCache = new Map([
    [`${orgId}:${userId}:${version}`, { modules: new Set<string>(), expiresAt }],
  ]);

  console.log(`Warmup: ${WARMUP} calls...`);
  for (let i = 0; i < WARMUP; i++) {
    await svc.resolveUserPermissions(orgId, userId);
  }

  console.log(`Benchmark: ${ITERATIONS} calls, measuring CPU time only...`);
  const cpuBefore = process.cpuUsage();
  for (let i = 0; i < ITERATIONS; i++) {
    await svc.resolveUserPermissions(orgId, userId);
  }
  const cpuAfter = process.cpuUsage(cpuBefore);

  const totalCpuUs = (cpuAfter.user + cpuAfter.system);
  const perCallCpuUs = totalCpuUs / ITERATIONS;

  const cpuClockGranularityUs = measureCpuClockGranularityUs();

  const batchCpuSamples: number[] = [];
  for (let batch = 0; batch < BATCHES; batch++) {
    const before = process.cpuUsage();
    for (let i = 0; i < BATCH_SIZE; i++) {
      await svc.resolveUserPermissions(orgId, userId);
    }
    const after = process.cpuUsage(before);
    batchCpuSamples.push((after.user + after.system) / BATCH_SIZE);
  }
  batchCpuSamples.sort((a, b) => a - b);

  const wallSamples: number[] = [];
  for (let i = 0; i < WALL_SAMPLES; i++) {
    const before = process.hrtime.bigint();
    await svc.resolveUserPermissions(orgId, userId);
    wallSamples.push(Number(process.hrtime.bigint() - before) / 1000);
  }
  wallSamples.sort((a, b) => a - b);

  const p99 = percentile(batchCpuSamples, 99);
  const p50 = percentile(batchCpuSamples, 50);
  const maxSample = batchCpuSamples[batchCpuSamples.length - 1] ?? null;
  const wallP99 = percentile(wallSamples, 99);
  const wallP50 = percentile(wallSamples, 50);

  const target = 100;
  const verdict =
    p99 !== null && wallP99 !== null && p99 <= target && wallP99 <= target
      ? "MET"
      : "BREACHED";

  console.log("\nIn-process authorization benchmark results\n");
  console.log(`  total CPU (${ITERATIONS} calls): ${totalCpuUs.toFixed(0)} µs user+system`);
  console.log(`  avg CPU per call:               ${perCallCpuUs.toFixed(2)} µs`);
  console.log(`  CPU clock granularity:          ${cpuClockGranularityUs.toFixed(0)} µs`);
  console.log(`  p50 CPU per call (batch mean):  ${(p50 ?? 0).toFixed(2)} µs`);
  console.log(`  p99 CPU per call (batch mean):  ${(p99 ?? 0).toFixed(2)} µs`);
  console.log(`  max CPU per call (batch mean):  ${(maxSample ?? 0).toFixed(2)} µs`);
  console.log(`  p50 wall per call:              ${(wallP50 ?? 0).toFixed(2)} µs`);
  console.log(`  p99 wall per call:              ${(wallP99 ?? 0).toFixed(2)} µs`);
  console.log(`  target:                         ${target} µs CPU without I/O`);
  console.log(`  verdict:                        ${verdict}`);
  console.log("\nConditions:");
  console.log("  - Real AccessService.resolveUserPermissions called via the public entry point");
  console.log("  - All four in-process caches (versionCache, permsCache, membershipAccessCache,");
  console.log("    deniedModulesCache) primed before measurement; zero I/O on the measured calls");
  console.log("  - Stub dependencies throw on any cold-path access (none fired)");
  console.log("  - CPU time via process.cpuUsage() (user + system), not wall clock");
  console.log("  - Warm path: Map.get × 3 → applyUniversalGrants (real method) → return");
  console.log("  - Promise micro-task overhead is included because resolveUserPermissions is async");

  const out = {
    generatedAtMs: Date.now(),
    objective: "p99-in-process-authorization",
    target,
    unit: "µs CPU time without I/O",
    iterations: ITERATIONS,
    perCallAvgCpuUs: perCallCpuUs,
    p50CpuUs: p50,
    p99CpuUs: p99,
    maxSampleCpuUs: maxSample,
    p50WallUs: wallP50,
    p99WallUs: wallP99,
    cpuClockGranularityUs,
    batchSize: BATCH_SIZE,
    batches: BATCHES,
    verdict,
    conditions: {
      warmPath: "all four in-process caches primed; zero I/O on measured calls",
      service: "real AccessService instance, real applyUniversalGrants and stripDeniedModules called",
      stubIntegrity: "stub dependencies throw on any call; none fired during benchmark",
      measurement: `process.cpuUsage() over batches of ${BATCH_SIZE} calls, divided by the batch size. The CPU clock here ticks at ${cpuClockGranularityUs.toFixed(0)} µs, so a per-call cpuUsage() delta reads 0 for almost every call and its percentiles are the clock's resolution rather than the product's cost. Batching lifts each sample above the tick. The reported percentiles are therefore percentiles OF BATCH MEANS, not of individual calls, and a single slow call is averaged into its batch.`,
      wallClockCheck: `process.hrtime.bigint() gives per-call nanosecond resolution, so the wall figures ARE a true per-call distribution. Wall approximates CPU here only because the measured path performs no I/O — the stub dependencies throw if any cold path is reached and none fired. The verdict requires BOTH the batch-mean CPU p99 and the per-call wall p99 to be within target.`,
      asyncOverhead:
        "included — resolveUserPermissions is async, so Promise micro-task scheduling is part of each call's CPU cost",
      note: "The PRD target (100 µs CPU) is for the in-process warm path with no I/O. This benchmark measures exactly that path. The live application's wall-clock budget per request is larger (route overhead, event-loop delay, network) but that is not this objective.",
    },
  };

  writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
  console.log(`\nresults: ${OUT}`);

  if (p99 !== null && p99 > target) process.exitCode = 1;
}

run().catch((e) => {
  console.error("BENCHMARK FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
