import * as net from "node:net";
import { Redis, type Requester, type UpstashRequest, type UpstashResponse } from "@upstash/redis";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
// eslint-disable-next-line no-restricted-imports
import * as schema from "../../../../db/schema";
import { createTenantAwareDb, type DbWithClient } from "../../../../common/tenant/tenant-db";
import type { TenantTx } from "../../../../db/drizzle.types";
import { CacheService } from "../../../../common/cache/cache.service";
import { dbSpecSuite, dbSpecClient } from "../../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import { ensureFixtureOrgs } from "../../../../test/db-spec-fixture";
import { PlanLimitsService } from "../plan-limits.service";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { observeAfterCommitWork } from "../../../../common/observability/after-commit-work";

jest.setTimeout(60_000);

function encodeResp2(args: string[]): Buffer {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const argBytes = Buffer.from(arg, "utf8");
    out += `$${argBytes.byteLength}\r\n${arg}\r\n`;
  }
  return Buffer.from(out, "utf8");
}

type Resp2Parsed =
  | { done: true; ok: true; value: string | number | null }
  | { done: true; ok: false; error: string }
  | { done: false };

function tryParseResp2(raw: string): Resp2Parsed {
  if (raw.length === 0) return { done: false };
  const first = raw[0];
  if (first === "+") {
    const end = raw.indexOf("\r\n");
    if (end === -1) return { done: false };
    return { done: true, ok: true, value: raw.slice(1, end) };
  }
  if (first === "-") {
    const end = raw.indexOf("\r\n");
    if (end === -1) return { done: false };
    return { done: true, ok: false, error: raw.slice(1, end) };
  }
  if (first === ":") {
    const end = raw.indexOf("\r\n");
    if (end === -1) return { done: false };
    return { done: true, ok: true, value: parseInt(raw.slice(1, end), 10) };
  }
  if (first === "$") {
    const eol = raw.indexOf("\r\n");
    if (eol === -1) return { done: false };
    const len = parseInt(raw.slice(1, eol), 10);
    if (len === -1) return { done: true, ok: true, value: null };
    const start = eol + 2;
    if (raw.length < start + len + 2) return { done: false };
    return { done: true, ok: true, value: raw.slice(start, start + len) };
  }
  if (first === "*") {
    const eol = raw.indexOf("\r\n");
    if (eol === -1) return { done: false };
    return { done: true, ok: true, value: parseInt(raw.slice(1, eol), 10) };
  }
  return { done: true, ok: false, error: `unexpected RESP2 prefix: ${first ?? "(empty)"}` };
}

function toUpstashResponse<TResult>(parsed: Resp2Parsed & { done: true }): UpstashResponse<TResult> {
  if (!parsed.ok) return { error: parsed.error };
  const raw: unknown = parsed.value;
  return { result: raw as TResult };
}

class LocalRedisRequester implements Requester {
  request<TResult>(req: UpstashRequest): Promise<UpstashResponse<TResult>> {
    const body = req.body;
    if (!Array.isArray(body)) return Promise.resolve({ error: "body is not an array" });
    const args = (body as unknown[]).map(String);
    const encoded = encodeResp2(args);
    return new Promise<UpstashResponse<TResult>>((resolve) => {
      const socket = new net.Socket();
      let buf = "";
      let settled = false;
      const settle = (value: UpstashResponse<TResult>): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.connect(6379, "127.0.0.1", () => { socket.write(encoded); });
      socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const parsed = tryParseResp2(buf);
        if (parsed.done) settle(toUpstashResponse<TResult>(parsed));
      });
      socket.on("error", (err: Error) => { settle({ error: err.message }); });
      socket.on("close", () => { settle({ error: "connection closed" }); });
    });
  }
}

function buildDb(rawClient: ReturnType<typeof postgres>): DbWithClient {
  const endableClient: DbWithClient["__client"] = {
    end: (opts: { timeout: number }): Promise<void> => rawClient.end({ timeout: opts.timeout }),
  };
  return createTenantAwareDb(Object.assign(drizzle(rawClient, { schema }), { __client: endableClient }));
}

const SUITE = dbSpecSuite(["DATABASE_URL", "APP_DATABASE_URL"]);

SUITE("billing quota-alert redis dedup — real Redis + Postgres", () => {
  let rawClient: ReturnType<typeof postgres>;
  let db: DbWithClient;
  let redis: Redis;
  let cache: CacheService;
  let orgId = "";

  const dedupKey100 = (): string => `billing:quota-alert:${orgId}:automations:100`;
  const dedupKey80 = (): string => `billing:quota-alert:${orgId}:automations:80`;

  beforeAll(async () => {
    const url = requireApprovedDatabaseUrl({
      spec: "quota-alert-redis-dedup.db.spec.ts",
      vars: ["APP_DATABASE_URL", "DATABASE_URL"],
    });
    const sqlClient = dbSpecClient(url);
    const [fixture] = await ensureFixtureOrgs(sqlClient, 1);
    if (!fixture) throw new Error("ensureFixtureOrgs returned no orgs");
    orgId = fixture.orgId;
    await sqlClient.end({ timeout: 5 });

    rawClient = postgres(url, { max: 1, prepare: false });
    db = buildDb(rawClient);

    redis = new Redis(new LocalRedisRequester());
    cache = new CacheService(redis, 3_000);
  }, 60_000);

  afterAll(async () => {
    if (orgId) await redis.del(dedupKey100(), dedupKey80()).catch(() => undefined);
    if (rawClient) await rawClient.end({ timeout: 5 });
  }, 30_000);

  beforeEach(async () => {
    if (orgId) await redis.del(dedupKey100(), dedupKey80()).catch(() => undefined);
  });

  function makeSvc(cacheOverride?: CacheService): { svc: PlanLimitsService; createSpy: jest.Mock } {
    const svc = new PlanLimitsService(db, cacheOverride ?? cache, null);
    const createSpy: jest.Mock = jest.fn(() => Promise.resolve());
    Object.assign(svc, { notifications: { create: createSpy } });
    return { svc, createSpy };
  }

  async function runTxAndAwaitHooks(fn: (tx: TenantTx) => Promise<void>): Promise<void> {
    const completions: Promise<unknown>[] = [];
    const unobserve = observeAfterCommitWork((c) => { completions.push(c); });
    await runInNewTenantTransaction(db, orgId, fn);
    await Promise.all(completions);
    unobserve();
  }

  it("rollback: after-commit hook is not drained and the dedup key is absent from Redis", async () => {
    const { svc } = makeSvc();
    const completions: Promise<unknown>[] = [];
    const unobserve = observeAfterCommitWork((c) => { completions.push(c); });

    await expect(
      runInNewTenantTransaction(db, orgId, async (tx) => {
        await svc.assertWithinLimit(orgId, "automations", 1, tx);
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    await Promise.all(completions);
    unobserve();

    expect(completions).toHaveLength(0);
    expect(await redis.get(dedupKey100())).toBeNull();
  });

  it("commit: alert fires for both thresholds and dedup blocks re-fire within the window", async () => {
    const { svc, createSpy } = makeSvc();

    await runTxAndAwaitHooks(async (tx) => {
      await svc.assertWithinLimit(orgId, "automations", 1, tx);
    });

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(await redis.get(dedupKey100())).toBeTruthy();
    expect(await redis.get(dedupKey80())).toBeTruthy();

    await runTxAndAwaitHooks(async (tx) => {
      await svc.assertWithinLimit(orgId, "automations", 1, tx);
    });

    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it("dedup key removal allows the alert to re-fire (racing fill/bust)", async () => {
    const { svc, createSpy } = makeSvc();

    await runTxAndAwaitHooks(async (tx) => {
      await svc.assertWithinLimit(orgId, "automations", 1, tx);
    });
    expect(createSpy).toHaveBeenCalledTimes(2);

    await redis.del(dedupKey100(), dedupKey80());

    await runTxAndAwaitHooks(async (tx) => {
      await svc.assertWithinLimit(orgId, "automations", 1, tx);
    });
    expect(createSpy).toHaveBeenCalledTimes(4);
  });

  it("null Redis: alert fires for all thresholds even when Redis is unavailable — warning is never swallowed", async () => {
    const nullCache = new CacheService(null, 3_000);
    const { svc, createSpy } = makeSvc(nullCache);

    await runTxAndAwaitHooks(async (tx) => {
      await svc.assertWithinLimit(orgId, "automations", 1, tx);
    });

    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});
