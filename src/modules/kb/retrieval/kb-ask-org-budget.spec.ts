jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

import { HttpException, HttpStatus } from "@nestjs/common";
import {
  effectiveRateLimit,
  rateLimitWindowSecs,
} from "../../../common/ratelimit/rate-limit.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbAskService, KB_ASK_ORG_TIER, kbAskOrgKey } from "./kb-ask.service";

const ORG = "org-1";
const QUESTION = "how do I reset my password";

interface BudgetEntry {
  value: number;
  expiresAt: number | null;
}

class FakeRedis {
  readonly store = new Map<string, BudgetEntry>();

  readonly incr = jest.fn().mockResolvedValue(1);
  readonly expire = jest.fn().mockResolvedValue(1);
  readonly ttl = jest.fn().mockResolvedValue(-1);

  readonly scripts: string[] = [];

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
}

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function makeService(redis: FakeRedis) {
  const db = {
    execute: jest.fn().mockResolvedValue([]),
    insert: jest.fn(() => ({ values: jest.fn().mockResolvedValue([]) })),
  };
  const gateway = {
    invokeTextWithUsage: jest.fn(),
    streamTextWithUsage: jest.fn(),
  };
  const search = {
    aclCacheOutcome: jest.fn().mockResolvedValue("miss"),
    resolveQueryEmbedding: jest.fn().mockResolvedValue({ vectorLiteral: null }),
    retrieveTopArticles: jest.fn().mockResolvedValue([]),
    retrieveTopSources: jest.fn().mockResolvedValue([]),
    retrieveDocumentPassages: jest.fn().mockResolvedValue([]),
  };
  const events = { record: jest.fn().mockResolvedValue(undefined) };
  const linkedDocuments = { retrieve: jest.fn().mockResolvedValue([]) };

  const service = new KbAskService(
    db as never,
    gateway as never,
    events as never,
    search as never,
    {} as never,
    linkedDocuments as never,
    redis as never,
  );
  return { service, gateway };
}

describe("KB ask org budget — the window must survive a crash between INCR and EXPIRE", () => {
  it("leaves a TTL on the budget key it creates, so the window expires instead of 429ing the org for the life of the key", async () => {
    const redis = new FakeRedis();
    const { service } = makeService(redis);

    await service.ask(makeUser(), { question: QUESTION });

    expect(redis.store.get(kbAskOrgKey(ORG))?.expiresAt).not.toBeNull();
  });

  it("re-arms a budget key found stranded with no TTL, because a counter that never expires 429s the org forever", async () => {
    const redis = new FakeRedis();
    redis.store.set(kbAskOrgKey(ORG), { value: 5, expiresAt: null });
    const { service } = makeService(redis);

    await service.ask(makeUser(), { question: QUESTION });

    const entry = redis.store.get(kbAskOrgKey(ORG));
    expect(entry?.value).toBe(6);
    expect(entry?.expiresAt).not.toBeNull();
  });

  it("spends the budget in one server-side script, not a client INCR followed by a separate EXPIRE that a crash can skip", async () => {
    const redis = new FakeRedis();
    const { service } = makeService(redis);

    await service.ask(makeUser(), { question: QUESTION });

    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
    expect(redis.scripts[0]).toContain("EXPIRE");
  });

  it("refuses with 429 and a positive retry delay once the tier's effective budget is spent", async () => {
    const redis = new FakeRedis();
    redis.store.set(kbAskOrgKey(ORG), {
      value: effectiveRateLimit(KB_ASK_ORG_TIER),
      expiresAt: Date.now() + rateLimitWindowSecs(KB_ASK_ORG_TIER) * 1000,
    });
    const { service, gateway } = makeService(redis);

    const caught = await service
      .ask(makeUser(), { question: QUESTION })
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
    expect(Number(retryAfterSecs)).toBeGreaterThan(0);
    expect(gateway.invokeTextWithUsage).not.toHaveBeenCalled();
  });

  it("admits the request one hit below the tier's effective budget, so the refusal above is the limit and not a blanket denial", async () => {
    const redis = new FakeRedis();
    redis.store.set(kbAskOrgKey(ORG), {
      value: effectiveRateLimit(KB_ASK_ORG_TIER) - 2,
      expiresAt: Date.now() + rateLimitWindowSecs(KB_ASK_ORG_TIER) * 1000,
    });
    const { service } = makeService(redis);

    const result = await service.ask(makeUser(), { question: QUESTION });

    expect(result.hasContext).toBe(false);
  });

  it("spends the same atomic budget on the streaming path, so a stream cannot bypass the org cap", async () => {
    const redis = new FakeRedis();
    redis.store.set(kbAskOrgKey(ORG), {
      value: effectiveRateLimit(KB_ASK_ORG_TIER),
      expiresAt: Date.now() + rateLimitWindowSecs(KB_ASK_ORG_TIER) * 1000,
    });
    const { service, gateway } = makeService(redis);
    const signal = new AbortController().signal;

    const caught = await service
      .streamAsk(makeUser(), { question: QUESTION }, signal)
      .then(() => null)
      .catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(HttpException);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(gateway.streamTextWithUsage).not.toHaveBeenCalled();
  });
});
