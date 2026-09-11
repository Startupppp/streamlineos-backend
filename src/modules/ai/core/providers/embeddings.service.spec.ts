import { Test } from "@nestjs/testing";
import { EmbeddingsService, EMBEDDING_MODEL } from "./embeddings.service";

const FAKE_VEC = [0.1, 0.2, 0.3];

function buildMockClient(embedDocuments?: jest.Mock) {
  return {
    embedQuery: jest.fn().mockResolvedValue(FAKE_VEC),
    embedDocuments: embedDocuments ?? jest.fn().mockResolvedValue([FAKE_VEC]),
  };
}

async function buildService(embedDocuments?: jest.Mock) {
  const module = await Test.createTestingModule({
    providers: [EmbeddingsService],
  }).compile();

  const service = module.get(EmbeddingsService);
  const client = buildMockClient(embedDocuments);
  (service as unknown as Record<string, unknown>)["embeddings"] = client;
  process.env["OPENAI_API_KEY"] = "test-key";

  return { service, client };
}

afterEach(() => {
  delete process.env["OPENAI_API_KEY"];
  jest.clearAllMocks();
});

describe("EmbeddingsService — raw provider primitives only", () => {
  it("exposes no un-metered embedding entry point: every public method is raw or a pure helper", () => {
    const surface = Object.getOwnPropertyNames(EmbeddingsService.prototype)
      .filter((name) => name !== "constructor" && !name.startsWith("get"))
      .sort();
    expect(surface).toEqual(["embedBatchRaw", "embedQueryRaw", "isConfigured", "toVectorLiteral"]);
  });

  it("embedQueryRaw delegates to the provider and returns the vector", async () => {
    const { service, client } = await buildService();
    await expect(service.embedQueryRaw("hello")).resolves.toEqual(FAKE_VEC);
    expect(client.embedQuery).toHaveBeenCalledWith("hello");
  });

  it("embedBatchRaw splits into provider batches of at most 64 and preserves order", async () => {
    const embedDocuments = jest
      .fn()
      .mockImplementation((texts: string[]) => Promise.resolve(texts.map((t) => [Number(t)])));
    const { service } = await buildService(embedDocuments);

    const texts = Array.from({ length: 150 }, (_, i) => String(i));
    const vectors = await service.embedBatchRaw(texts);

    expect(embedDocuments).toHaveBeenCalledTimes(3);
    for (const call of embedDocuments.mock.calls)
      expect((call[0] as string[]).length).toBeLessThanOrEqual(64);

    expect(vectors).toHaveLength(150);
    expect(vectors[0]).toEqual([0]);
    expect(vectors[63]).toEqual([63]);
    expect(vectors[64]).toEqual([64]);
    expect(vectors[149]).toEqual([149]);
  });

  it("embedBatchRaw short-circuits on an empty batch without touching the provider", async () => {
    const { service, client } = await buildService();
    await expect(service.embedBatchRaw([])).resolves.toEqual([]);
    expect(client.embedDocuments).not.toHaveBeenCalled();
  });

  it("isConfigured tracks the API key and the model id is the priced one", async () => {
    const { service } = await buildService();
    expect(service.isConfigured()).toBe(true);
    delete process.env["OPENAI_API_KEY"];
    expect(service.isConfigured()).toBe(false);
    expect(EMBEDDING_MODEL).toBe("text-embedding-3-small");
  });

  it("toVectorLiteral renders a pgvector literal", async () => {
    const { service } = await buildService();
    expect(service.toVectorLiteral([1, 2.5, -3])).toBe("[1,2.5,-3]");
  });

  it("throws a configuration error rather than calling the provider with no key", async () => {
    const module = await Test.createTestingModule({ providers: [EmbeddingsService] }).compile();
    const service = module.get(EmbeddingsService);
    delete process.env["OPENAI_API_KEY"];
    await expect(service.embedQueryRaw("x")).rejects.toThrow("OPENAI_API_KEY is required");
  });
});
