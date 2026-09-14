import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SignJWT, importJWK } from "jose";
import { CACHE_HIT_CEILING_MS } from "./timing-slo-thresholds.mjs";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = arg("url", "http://127.0.0.1:1500").replace(/\/$/, "");
const ROUTES = arg("routes", "/me/access,/organization,/billing/entitlements").split(",").map((s) => s.trim()).filter(Boolean);
const USER = arg("user", "bbbbbbbb-0001-0000-0000-000000000001");
const ORG = arg("org", "aaaaaaaa-1111-0000-0000-000000000001");
const N = Number(arg("n", "200"));
const WARMUP = Number(arg("warmup", "20"));
const CONCURRENCY = arg("concurrency", "1,8").split(",").map(Number);
const PHASE = arg("phase", "hit");
const CEILING_MS = Number(arg("ceiling-ms", String(CACHE_HIT_CEILING_MS)));
const OUT = resolve(process.cwd(), arg("out", `.artifacts/cache-${PHASE}-latency.json`));

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export function summarize(route, concurrency, samples, statuses, wallMs) {
  const sorted = [...samples].sort((a, b) => a - b);
  const non2xx = Object.entries(statuses)
    .filter(([status]) => !status.startsWith("2"))
    .reduce((sum, [, count]) => sum + count, 0);
  return {
    route,
    concurrency,
    n: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? null,
    statuses,
    non2xx,
    wallMs,
  };
}

export function verdict(results, ceilingMs) {
  const breaches = results.filter((r) => r.non2xx > 0 || r.n === 0 || r.p95Ms > ceilingMs);
  return { pass: breaches.length === 0, breaches: breaches.map((r) => `${r.route}@c${r.concurrency}: p95 ${r.p95Ms} ms, non2xx ${r.non2xx}, n ${r.n}`) };
}

async function signToken() {
  const keys = JSON.parse(process.env.AUTH_SIGNING_KEYS ?? "[]");
  const current = keys[keys.length - 1];
  if (!current) throw new Error("AUTH_SIGNING_KEYS is required to sign a probe token");
  const privateKey = await importJWK(current.privateKey, "EdDSA");
  return new SignJWT({ orgId: ORG, sessionId: `probe-${randomUUID()}` })
    .setProtectedHeader({ alg: "EdDSA", kid: current.kid })
    .setSubject(USER)
    .setIssuer("streamlineos-web")
    .setAudience("streamlineos-api")
    .setIssuedAt()
    .setExpirationTime("10m")
    .setJti(randomUUID())
    .sign(privateKey);
}

async function timedGet(route, token) {
  const started = process.hrtime.bigint();
  const response = await fetch(`${BASE}${route}`, { headers: { authorization: `Bearer ${token}` } });
  await response.arrayBuffer();
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, status: String(response.status) };
}

async function measure(route, token, concurrency) {
  for (let i = 0; i < WARMUP; i++) await timedGet(route, token);
  const samples = [];
  const statuses = {};
  let issued = 0;
  const worker = async () => {
    while (issued < N) {
      issued++;
      const sample = await timedGet(route, token);
      samples.push(sample.ms);
      statuses[sample.status] = (statuses[sample.status] ?? 0) + 1;
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  return summarize(route, concurrency, samples, statuses, Date.now() - started);
}

function selfTest() {
  const cases = [
    ["percentile of an empty set is null", percentile([], 0.95) === null],
    ["p95 of 1..100 is 96", percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95) === 96],
    ["a non-2xx sample fails the verdict", verdict([summarize("/x", 1, [1, 2], { 200: 1, 500: 1 }, 5)], 100).pass === false],
    ["a p95 over the ceiling fails the verdict", verdict([summarize("/x", 1, [1, 200], { 200: 2 }, 5)], 100).pass === false],
    ["an empty measurement fails the verdict", verdict([summarize("/x", 1, [], {}, 0)], 100).pass === false],
    ["a bounded 2xx measurement passes", verdict([summarize("/x", 8, [3, 4, 5], { 200: 3 }, 5)], 100).pass === true],
  ];
  const failures = cases.filter(([, ok]) => !ok);
  for (const [name, ok] of cases) console.log(`  [${ok ? "pass" : "FAIL"}] ${name}`);
  console.log(`${cases.length - failures.length}/${cases.length} checks passed`);
  process.exit(failures.length > 0 ? 1 : 0);
}

async function main() {
  const token = await signToken();
  const results = [];
  for (const route of ROUTES)
    for (const concurrency of CONCURRENCY) results.push(await measure(route, token, concurrency));
  const outcome = verdict(results, CEILING_MS);
  console.log(`cache-${PHASE} latency against ${BASE} · n=${N} per route/concurrency · warmup ${WARMUP} · ceiling p95 ≤ ${CEILING_MS} ms`);
  for (const r of results)
    console.log(
      `  ${r.route.padEnd(28)} c${String(r.concurrency).padEnd(3)} p50 ${r.p50Ms.toFixed(2).padStart(8)} ms  p95 ${r.p95Ms.toFixed(2).padStart(8)} ms  p99 ${r.p99Ms.toFixed(2).padStart(8)} ms  max ${r.maxMs.toFixed(1).padStart(8)} ms  ${JSON.stringify(r.statuses)}`,
    );
  console.log(outcome.pass ? "RESULT: PASS" : `RESULT: FAIL — ${outcome.breaches.join("; ")}`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, phase: PHASE, user: USER, org: ORG, n: N, warmup: WARMUP, ceilingMs: CEILING_MS, results, verdict: outcome }, null, 2),
  );
  console.log(`wrote ${OUT}`);
  process.exit(outcome.pass ? 0 : 1);
}

if (process.argv.includes("--self-test")) selfTest();
else main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
