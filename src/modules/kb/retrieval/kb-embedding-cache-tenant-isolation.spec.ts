import { KbEmbeddingCache } from "./kb-embedding-cache";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";

const QUERY = "how does onboarding work";
const ORG_A = "org-a";
const ORG_B = "org-b";
const VECTOR_A = "[0.1,0.2]";

function makeCache(): CacheService {
  const store = new Map<string, unknown>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
  } as unknown as CacheService;
}

function makeGateway(): { gateway: AiGatewayService; calls: string[] } {
  const calls: string[] = [];
  const gateway = {
    isEmbeddingConfigured: () => true,
    embedQueryWithCredit: jest.fn(async (opts: { orgId: string }) => {
      calls.push(opts.orgId);
      return { ok: true as const, vector: [0.1, 0.2], vectorLiteral: VECTOR_A };
    }),
  } as unknown as AiGatewayService;
  return { gateway, calls };
}

describe("KB query embedding cache is scoped per tenant", () => {
  it("charges a second org for the same query instead of serving it the first org's cached vector, because a shared cache entry lets one tenant spend another tenant's credits and skips the credit reservation entirely", async () => {
    const cache = makeCache();
    const { gateway, calls } = makeGateway();
    const subject = new KbEmbeddingCache(gateway, cache);

    await subject.embedOrDegrade(QUERY, ORG_A);
    await subject.embedOrDegrade(QUERY, ORG_B);

    expect(calls).toEqual([ORG_A, ORG_B]);
  });

  it("CONTROL: still serves the same org's repeat query from cache, so tenant scoping did not simply disable caching", async () => {
    const cache = makeCache();
    const { gateway, calls } = makeGateway();
    const subject = new KbEmbeddingCache(gateway, cache);

    await subject.embedOrDegrade(QUERY, ORG_A);
    await subject.embedOrDegrade(QUERY, ORG_A);

    expect(calls).toEqual([ORG_A]);
  });

  it("writes the org into the cache key itself, so two tenants can never collide on one entry", async () => {
    const cache = makeCache();
    const { gateway } = makeGateway();
    const subject = new KbEmbeddingCache(gateway, cache);

    await subject.embedOrDegrade(QUERY, ORG_A);
    await subject.embedOrDegrade(QUERY, ORG_B);

    const writtenKeys = (cache.set as jest.Mock).mock.calls.map(
      (call: unknown[]) => String(call[0]),
    );

    expect(writtenKeys).toHaveLength(2);
    expect(writtenKeys[0]).not.toBe(writtenKeys[1]);
    expect(writtenKeys[0]).toContain(ORG_A);
    expect(writtenKeys[1]).toContain(ORG_B);
  });
});
