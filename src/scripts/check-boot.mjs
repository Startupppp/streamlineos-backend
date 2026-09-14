#!/usr/bin/env node
import { PRODUCTION_HOST_PATTERNS } from "./lib/production-host-guard.mjs";
/**
 * Boots the compiled application and asserts it reaches a healthy listener.
 *
 * Every other gate in this repository inspects source or emits artifacts. None of
 * them constructs the NestJS DI container, and DI wiring is runtime metadata, so a
 * provider that is injected but never registered passes `tsc`, passes `nest build`
 * and passes ts-jest — then throws UnknownDependenciesException at boot and the
 * process exits before it listens. That happened: SignEnvelopeQueriesService was
 * injected into SignEnvelopesService at index [13] and absent from ESignModule,
 * while the release evidence recorded `nest build exit 0` as proof the application
 * worked. This gate is the discriminator a passing build cannot be.
 *
 *   node src/scripts/check-boot.mjs --env-file=<path> [--port=1500] [--timeout=90]
 *   node src/scripts/check-boot.mjs --self-test
 *
 * The target must be a loopback scratch database. Production host patterns are
 * refused outright and there is no override: this gate starts the real application,
 * which runs migrations-adjacent boot work and writes cache keys.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SELF_TEST = argv.includes("--self-test");


export function assertDisposableBootTarget(databaseUrl) {
  if (!databaseUrl)
    return { allowed: false, reason: "APP_DATABASE_URL is required; refusing to boot against an unidentified target" };
  for (const pattern of PRODUCTION_HOST_PATTERNS)
    if (databaseUrl.includes(pattern))
      return { allowed: false, reason: `database URL contains '${pattern}' — a known production host` };
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { allowed: false, reason: "database URL does not parse" };
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  if (!loopback)
    return { allowed: false, reason: `database host '${parsed.hostname}' is not loopback` };
  const name = parsed.pathname.replace(/^\//, "");
  if (!name.includes("scratch"))
    return { allowed: false, reason: `database name '${name}' does not contain 'scratch'` };
  return { allowed: true, reason: `loopback scratch database '${name}'` };
}

export function classifyBootFailure(output) {
  if (/UnknownDependenciesException/.test(output)) {
    const match = /argument (\w+) at index \[(\d+)\] is available in the (\w+)/.exec(output);
    return match
      ? { kind: "DI_UNRESOLVED", detail: `${match[1]} at index [${match[2]}] is not registered in ${match[3]}` }
      : { kind: "DI_UNRESOLVED", detail: "a provider could not be resolved" };
  }
  if (/\[env\] Validation failed/.test(output)) return { kind: "ENV_INVALID", detail: "environment validation failed" };
  if (/ECONNREFUSED|ENOTFOUND|getaddrinfo/.test(output)) return { kind: "DEPENDENCY_UNREACHABLE", detail: "a boot dependency was unreachable" };
  return { kind: "UNKNOWN", detail: "process exited before listening" };
}

function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_0-9]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function waitForHealth(port, timeoutMs, child, collected) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { ok: false, exited: true };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body = await res.json();
        if (body?.data?.status === "ok" || body?.status === "ok") return { ok: true };
      }
    } catch {
      void collected;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, exited: false };
}

async function main() {
  const envFile = arg("env-file", "");
  if (!envFile) {
    console.error("FAIL: --env-file=<path> is required. This gate never falls back to .env.");
    process.exit(2);
  }
  const envPath = resolve(envFile);
  if (!existsSync(envPath)) {
    console.error(`FAIL: env file not found: ${envPath}`);
    process.exit(2);
  }
  const fileEnv = parseEnvFile(envPath);
  const verdict = assertDisposableBootTarget(fileEnv.APP_DATABASE_URL ?? fileEnv.DATABASE_URL);
  if (!verdict.allowed) {
    console.error(`FAIL: refusing to boot — ${verdict.reason}`);
    process.exit(2);
  }
  const entry = resolve(process.cwd(), "dist/main.js");
  if (!existsSync(entry)) {
    console.error("FAIL: dist/main.js is missing. Build before running the boot gate.");
    process.exit(2);
  }
  const port = Number(arg("port", fileEnv.PORT ?? "1500"));
  const timeout = Number(arg("timeout", "90")) * 1000;

  console.log(`boot gate: ${verdict.reason}, port ${port}`);
  let collected = "";
  const child = spawn(process.execPath, ["--max-old-space-size=8192", `--env-file=${envPath}`, entry], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { collected += d.toString(); });
  child.stderr.on("data", (d) => { collected += d.toString(); });

  const result = await waitForHealth(port, timeout, child, collected);
  child.kill();
  await new Promise((r) => setTimeout(r, 500));

  if (result.ok) {
    console.log("PASS: application booted and /health answered ok. DI container resolved.");
    process.exit(0);
  }
  const failure = classifyBootFailure(collected);
  console.error(`FAIL: ${failure.kind} — ${failure.detail}`);
  const lines = collected.split(/\r?\n/).filter((l) => /Error|Exception|Fatal/.test(l)).slice(0, 6);
  for (const line of lines) console.error(`  ${line.slice(0, 400)}`);
  process.exit(1);
}

function selfTest() {
  const cases = [
    [assertDisposableBootTarget("postgresql://u:p@127.0.0.1:5432/scratch_local"), true],
    [assertDisposableBootTarget("postgresql://u:p@localhost:5432/scratch_boot"), true],
    [assertDisposableBootTarget("postgresql://u:p@prod.cluster.amazonaws.com:5432/scratch_local"), false],
    [assertDisposableBootTarget("postgresql://u:p@db.neon.tech:5432/scratch_local"), false],
    [assertDisposableBootTarget("postgresql://u:p@10.0.0.5:5432/scratch_local"), false],
    [assertDisposableBootTarget("postgresql://u:p@127.0.0.1:5432/streamlineos"), false],
    [assertDisposableBootTarget(""), false],
    [assertDisposableBootTarget("not-a-url"), false],
  ];
  let failures = 0;
  for (const [verdict, expected] of cases) {
    if (verdict.allowed !== expected) {
      console.error(`FAIL: refusal mismatch — ${verdict.reason}`);
      failures++;
    }
  }
  const di = classifyBootFailure(
    "UnknownDependenciesException [Error]: Nest can't resolve dependencies of the SignEnvelopesService (DRIZZLE, ?). Please make sure that the argument SignEnvelopeQueriesService at index [13] is available in the ESignModule module.",
  );
  if (di.kind !== "DI_UNRESOLVED" || !di.detail.includes("SignEnvelopeQueriesService")) {
    console.error(`FAIL: DI classification did not name the missing provider — got ${JSON.stringify(di)}`);
    failures++;
  }
  if (classifyBootFailure("[env] Validation failed:\n  PORT").kind !== "ENV_INVALID") {
    console.error("FAIL: env classification");
    failures++;
  }
  if (classifyBootFailure("connect ECONNREFUSED 127.0.0.1:5432").kind !== "DEPENDENCY_UNREACHABLE") {
    console.error("FAIL: dependency classification");
    failures++;
  }
  if (classifyBootFailure("something else entirely").kind !== "UNKNOWN") {
    console.error("FAIL: unknown classification");
    failures++;
  }
  if (failures) {
    console.error(`self-test: ${failures} failing checks`);
    process.exit(1);
  }
  console.log("PASS: boot-gate self-test, 12 checks, refusals and failure classification both bite.");
  process.exit(0);
}

if (SELF_TEST) selfTest();
else main();
