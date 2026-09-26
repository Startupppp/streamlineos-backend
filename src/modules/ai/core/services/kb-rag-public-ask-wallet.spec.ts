jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
  runInNewTenantTransaction: (db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(db),
}));

import { HttpException, HttpStatus } from "@nestjs/common";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  effectiveRateLimit,
  rateLimitWindowSecs,
} from "../../../../common/ratelimit/rate-limit.service";
import { KbRagRetrievalService } from "./kb-rag-retrieval.service";
import { KbRagService, PUBLIC_KB_ASK_ORG_TIER, publicKbAskOrgKey } from "./kb-rag.service";

const ORG = "org-victim";
const QUESTION = "how do I reset my password";

const dialect = new PgDialect();

function render(cond: SQL): { text: string; params: unknown[] } {
  const query = dialect.sqlToQuery(cond);
  return { text: query.sql, params: query.params };
}

const ELIGIBLE_CHUNK_ROW = {
  id: 1,
  articleId: 10,
  attachmentId: null,
  source: "article_body",
  content: "Open the account page and choose reset.",
  title: "Password reset",
  slug: "password-reset",
  attachmentName: null,
  similarity: 0.9,
};

interface BudgetEntry {
  value: number;
  expiresAt: number | null;
}

class FakeRedis {
  readonly store = new Map<string, BudgetEntry>();

  readonly get = jest.fn().mockResolvedValue(null);
  readonly del = jest.fn().mockResolvedValue(1);
  readonly set = jest.fn().mockResolvedValue("OK");
  readonly incr = jest.fn().mockResolvedValue(1);
  readonly expire = jest.fn().mockResolvedValue(1);
  readonly ttl = jest.fn().mockResolvedValue(-1);

  readonly eval = jest.fn(
    (script: string, keys: string[], args: string[]): Promise<[number, number]> => {
      const key = keys[0] ?? "";
      const windowSecs = Number(args[0] ?? 0);
      const entry = this.store.get(key) ?? { value: 0, expiresAt: null };
      entry.value += 1;
      let ttl =
        entry.expiresAt === null ? -1 : Math.ceil((entry.expiresAt - Date.now()) / 1000);
      if (ttl < 0) {
        entry.expiresAt = Date.now() + windowSecs * 1000;
        ttl = windowSecs;
      }
      this.store.set(key, entry);
      this.scripts.push(script);
      return Promise.resolve([entry.value, ttl]);
    },
  );

  readonly scripts: string[] = [];
}

function makeDb(pages: unknown[][]) {
  const wheres: SQL[] = [];
  const froms: string[] = [];
  let index = -1;
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: jest.fn((table: never) => {
      froms.push(getTableName(table));
      return chain;
    }),
    innerJoin: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    where: jest.fn((cond: SQL) => {
      wheres.push(cond);
      return chain;
    }),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => Promise.resolve(pages[index] ?? [])),
  });
  const db = {
    select: jest.fn(() => {
      index += 1;
      return chain;
    }),
    insert: jest.fn(() => ({ values: jest.fn().mockResolvedValue(undefined) })),
  };
  return { db, wheres, froms };
}

function makeHarness(pages: unknown[][], redis: FakeRedis | null = null) {
  const { db, wheres, froms } = makeDb(pages);
  const gateway = {
    isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    embedQueryWithCredit: jest
      .fn()
      .mockResolvedValue({ ok: true, vector: [0.1, 0.2], vectorLiteral: "[0.1,0.2]" }),
    invokeText: jest.fn().mockResolvedValue({ ok: true, data: "the answer" }),
  };
  const ledger = { reserve: jest.fn(), settle: jest.fn(), release: jest.fn() };
  const usageSvc = { track: jest.fn() };
  const limiter = { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };

  const retrieval = new KbRagRetrievalService(db as never, gateway as never);
  const service = new KbRagService(
    retrieval,
    gateway as never,
    ledger as never,
    usageSvc as never,
    limiter as never,
    redis as never,
  );
  return { service, gateway, wheres, froms };
}

describe("public KB ask refuses to spend an org's AI credits for an anonymous caller", () => {
  it("never pays for an embedding for an org with nothing public to find, because the org id arrives from an anonymous request body", async () => {
    const { service, gateway } = makeHarness([[]]);

    const result = await service.answerQuestion({ orgId: ORG, question: QUESTION });

    expect(result.hasContext).toBe(false);
    expect(gateway.embedQueryWithCredit).toHaveBeenCalledTimes(0);
    expect(gateway.invokeText).toHaveBeenCalledTimes(0);
  });

  it("still reaches the embedding provider for an org that does have eligible public content, because a gate that always refused would pass the test above vacuously", async () => {
    const { service, gateway } = makeHarness([[{ id: 1 }], [ELIGIBLE_CHUNK_ROW]]);

    const result = await service.answerQuestion({ orgId: ORG, question: QUESTION });

    expect(result.hasContext).toBe(true);
    expect(gateway.embedQueryWithCredit).toHaveBeenCalledTimes(1);
    expect(gateway.embedQueryWithCredit).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, charge: true }),
    );
  });

  it("gates on an indexed chunk rather than a published page, because an org whose pages were never embedded still had the embedding charged to it", async () => {
    const { service, froms } = makeHarness([[]]);

    await service.answerQuestion({ orgId: ORG, question: QUESTION });

    expect(froms[0]).toBe("kb_article_chunks");
  });

  it("asks the gate with the identical predicate the chunk fetch applies, so a later widening of one cannot leave the other paying for it", async () => {
    const { service, wheres } = makeHarness([[{ id: 1 }], [ELIGIBLE_CHUNK_ROW]]);

    await service.answerQuestion({ orgId: ORG, question: QUESTION });

    const gate = render(wheres[0] as SQL);
    const fetch = render(wheres[1] as SQL);
    expect(gate.text).toBe(fetch.text);
    expect(gate.params).toEqual(fetch.params);
  });

  it("refuses the ask once the org's window budget is spent, because the per-IP tier is free to rotate its source address", async () => {
    const redis = new FakeRedis();
    const limit = effectiveRateLimit(PUBLIC_KB_ASK_ORG_TIER);
    redis.store.set(publicKbAskOrgKey(ORG), {
      value: limit - 1,
      expiresAt: Date.now() + rateLimitWindowSecs(PUBLIC_KB_ASK_ORG_TIER) * 1000,
    });
    const { service, gateway } = makeHarness([[], [], [], []], redis);

    const allowed = await service.answerQuestion({ orgId: ORG, question: QUESTION });
    expect(allowed.hasContext).toBe(false);

    await expect(service.answerQuestion({ orgId: ORG, question: QUESTION })).rejects.toThrow(
      HttpException,
    );
    expect(gateway.embedQueryWithCredit).toHaveBeenCalledTimes(0);
  });

  it("answers the refusal with 429 and a positive retry delay, so the caller is told when to come back", async () => {
    const redis = new FakeRedis();
    redis.store.set(publicKbAskOrgKey(ORG), {
      value: effectiveRateLimit(PUBLIC_KB_ASK_ORG_TIER),
      expiresAt: Date.now() + rateLimitWindowSecs(PUBLIC_KB_ASK_ORG_TIER) * 1000,
    });
    const { service } = makeHarness([[]], redis);

    const caught = await service
      .answerQuestion({ orgId: ORG, question: QUESTION })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(HttpException);
    if (!(caught instanceof HttpException)) return;
    expect(caught.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    const body = caught.getResponse();
    const retryAfterSecs =
      typeof body === "object" && body !== null && "retryAfterSecs" in body
        ? body.retryAfterSecs
        : null;
    expect(typeof retryAfterSecs).toBe("number");
    expect(Number(retryAfterSecs)).toBeGreaterThan(0);
  });

  it("leaves a TTL on the budget key it just created, so the window expires instead of banning the org for the life of the key", async () => {
    const redis = new FakeRedis();
    const { service } = makeHarness([[]], redis);

    await service.answerQuestion({ orgId: ORG, question: QUESTION });

    expect(redis.store.get(publicKbAskOrgKey(ORG))?.expiresAt).not.toBeNull();
  });

  it("re-arms the TTL on a budget key it finds stranded without one, because a counter that never expires 429s the org forever", async () => {
    const redis = new FakeRedis();
    redis.store.set(publicKbAskOrgKey(ORG), { value: 5, expiresAt: null });
    const { service } = makeHarness([[]], redis);

    await service.answerQuestion({ orgId: ORG, question: QUESTION });

    const entry = redis.store.get(publicKbAskOrgKey(ORG));
    expect(entry?.value).toBe(6);
    expect(entry?.expiresAt).not.toBeNull();
  });

  it("spends the budget inside one atomic script rather than a client INCR followed by a separate EXPIRE, which is how the authenticated sibling can lose a TTL to a crash", async () => {
    const redis = new FakeRedis();
    const { service } = makeHarness([[]], redis);

    await service.answerQuestion({ orgId: ORG, question: QUESTION });

    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.incr).toHaveBeenCalledTimes(0);
    expect(redis.expire).toHaveBeenCalledTimes(0);
    expect(redis.scripts[0]).toContain("INCR");
    expect(redis.scripts[0]).toContain("EXPIRE");
  });

  it("charges the org budget once per ask on the streaming twin too, so the cheaper door is not an unmetered way in", async () => {
    const redis = new FakeRedis();
    const { service } = makeHarness([[]], redis);

    await service.streamAnswer({ orgId: ORG, question: QUESTION });

    expect(redis.store.get(publicKbAskOrgKey(ORG))?.value).toBe(1);
  });

  it("never pays for an embedding on the streaming twin either, because stream-ask takes the same anonymous org id", async () => {
    const { service, gateway } = makeHarness([[]]);

    const result = await service.streamAnswer({ orgId: ORG, question: QUESTION });

    expect(result.hasContext).toBe(false);
    expect(gateway.embedQueryWithCredit).toHaveBeenCalledTimes(0);
  });
});
