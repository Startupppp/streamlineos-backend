import { KbEmbeddingCache, normalizeEmbeddableQuery } from "./kb-embedding-cache";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";

const ORG = "org-x";
const VECTOR_LITERAL = "[0.1,0.2]";

function makeGatewayCapturingText(): { gateway: AiGatewayService; texts: string[] } {
  const texts: string[] = [];
  const gateway = {
    embedQueryWithCredit: jest.fn(async (opts: { text: string }) => {
      texts.push(opts.text);
      return { ok: true as const, vector: [0.1, 0.2], vectorLiteral: VECTOR_LITERAL };
    }),
  } as unknown as AiGatewayService;
  return { gateway, texts };
}

function makeBackedCache(): CacheService {
  const store = new Map<string, unknown>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
  } as unknown as CacheService;
}

describe("KbEmbeddingCache key and provider input derive from the same normalized text", () => {
  it("provider receives the normalized form, not the raw whitespace-padded query", async () => {
    const { gateway, texts } = makeGatewayCapturingText();
    const subject = new KbEmbeddingCache(gateway, null);

    await subject.embedOrDegrade("  HELLO WORLD  ", ORG);

    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe(normalizeEmbeddableQuery("  HELLO WORLD  "));
    expect(texts[0]).toBe("hello world");
  });

  it("a semantically equivalent variant hits the cache without calling the provider again, proving key and provider input are derived from the same normalized value", async () => {
    const cache = makeBackedCache();
    const { gateway, texts } = makeGatewayCapturingText();
    const subject = new KbEmbeddingCache(gateway, cache);

    await subject.embedOrDegrade("  HELLO WORLD  ", ORG);
    await subject.embedOrDegrade("hello world", ORG);

    expect(texts).toHaveLength(1);
  });

  it("CONTROL: distinct normalized queries still produce distinct provider calls, so the second test above cannot trivially pass by disabling caching", async () => {
    const cache = makeBackedCache();
    const { gateway, texts } = makeGatewayCapturingText();
    const subject = new KbEmbeddingCache(gateway, cache);

    await subject.embedOrDegrade("hello world", ORG);
    await subject.embedOrDegrade("hello earth", ORG);

    expect(texts).toHaveLength(2);
  });
});
