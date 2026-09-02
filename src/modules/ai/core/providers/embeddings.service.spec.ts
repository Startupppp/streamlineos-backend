import { Test } from "@nestjs/testing";
import { EmbeddingsService, EMBEDDING_MODEL } from "./embeddings.service";
import { AiUsageService } from "../services/ai-usage.service";

const FAKE_VEC = [0.1, 0.2, 0.3];

function buildMockClient() {
  return {
    embedQuery: jest.fn().mockResolvedValue(FAKE_VEC),
    embedDocuments: jest.fn().mockResolvedValue([FAKE_VEC]),
  };
}

async function buildService(trackImpl?: jest.Mock) {
  const trackFn = trackImpl ?? jest.fn().mockResolvedValue(undefined);
  const usageService = { track: trackFn } as unknown as jest.Mocked<AiUsageService>;

  const module = await Test.createTestingModule({
    providers: [
      EmbeddingsService,
      { provide: AiUsageService, useValue: usageService },
    ],
  }).compile();

  const service = module.get(EmbeddingsService);
  const client = buildMockClient();
  (service as unknown as Record<string, unknown>)["embeddings"] = client;
  process.env["OPENAI_API_KEY"] = "test-key";

  return { service, usageService, client };
}

afterEach(() => {
  delete process.env["OPENAI_API_KEY"];
  jest.clearAllMocks();
});

describe("EmbeddingsService.embedQuery", () => {
  it("(a) records a usage row carrying the caller orgId", async () => {
    const { service, usageService } = await buildService();

    await service.embedQuery("hello world", "org-abc", "test.feature");

    expect(usageService.track).toHaveBeenCalledTimes(1);
    expect(usageService.track).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-abc",
        model: EMBEDDING_MODEL,
        feature: "test.feature",
        completionTokens: 0,
        metadata: expect.objectContaining({ tokenEstimate: true }),
      }),
    );
  });

  it("bite: track IS what makes assertion (a) green — omitting it turns it RED", async () => {
    const neverCalledTrack = jest.fn().mockResolvedValue(undefined);
    const { service } = await buildService(neverCalledTrack);

    neverCalledTrack.mockReset();
    neverCalledTrack.mockResolvedValue(undefined);

    const savedTrack = (service as unknown as Record<string, { track: jest.Mock }>)["usage"].track;
    (service as unknown as Record<string, { track: jest.Mock }>)["usage"].track = jest.fn().mockResolvedValue(undefined);

    await service.embedQuery("test", "org-xyz", "feat");

    const silentMock = (service as unknown as Record<string, { track: jest.Mock }>)["usage"].track;
    expect(silentMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-xyz" }));

    (service as unknown as Record<string, { track: jest.Mock }>)["usage"].track = savedTrack;
  });

  it("(track resilience) returns vector even when usage.track rejects", async () => {
    const failingTrack = jest.fn().mockRejectedValue(new Error("DB down"));
    const { service } = await buildService(failingTrack);

    const result = await service.embedQuery("resilience", "org-fail", "test");

    expect(result).toEqual(FAKE_VEC);
  });
});

describe("EmbeddingsService.embedBatch", () => {
  it("records one usage row for the whole batch with batchSize metadata", async () => {
    const { service, usageService } = await buildService();

    await service.embedBatch(["text one", "text two"], "org-batch", "kb.indexing");

    expect(usageService.track).toHaveBeenCalledTimes(1);
    expect(usageService.track).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-batch",
        model: EMBEDDING_MODEL,
        feature: "kb.indexing",
        completionTokens: 0,
        metadata: expect.objectContaining({ tokenEstimate: true, batchSize: 2 }),
      }),
    );
  });

  it("(track resilience) does not throw even when usage.track rejects", async () => {
    const { service, usageService } = await buildService();
    usageService.track = jest.fn().mockRejectedValue(new Error("DB down"));

    await expect(service.embedBatch(["a"], "org-fail", "feat")).resolves.toBeDefined();
  });
});

describe("EmbeddingsService.embedQueryDeduped — per-org usage with vector sharing", () => {
  it("(b) two orgs embedding the same text each get their own usage row; only ONE API call made", async () => {
    const { service, usageService, client } = await buildService();

    let resolveFirst!: (v: number[]) => void;
    client.embedQuery.mockReturnValueOnce(
      new Promise<number[]>((res) => { resolveFirst = res; }),
    );

    const org1Promise = service.embedQueryDeduped("shared text", "org-1", "test.dedup");
    const org2Promise = service.embedQueryDeduped("shared text", "org-2", "test.dedup");

    resolveFirst([0.9, 0.8]);

    const [vec1, vec2] = await Promise.all([org1Promise, org2Promise]);

    expect(vec1).toEqual([0.9, 0.8]);
    expect(vec2).toEqual([0.9, 0.8]);
    expect(client.embedQuery).toHaveBeenCalledTimes(1);

    const trackedOrgIds = usageService.track.mock.calls.map((c) => c[0].orgId);
    expect(trackedOrgIds).toContain("org-1");
    expect(trackedOrgIds).toContain("org-2");
    expect(usageService.track).toHaveBeenCalledTimes(2);
  });

  it("(track resilience) a track failure for one org does not prevent the other org from getting its vector", async () => {
    let callCount = 0;
    const partialFailTrack = jest.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1
        ? Promise.reject(new Error("track failed for org-1"))
        : Promise.resolve();
    });
    const { service, client } = await buildService(partialFailTrack);

    let resolveFirst!: (v: number[]) => void;
    client.embedQuery.mockReturnValueOnce(
      new Promise<number[]>((res) => { resolveFirst = res; }),
    );

    const org1Promise = service.embedQueryDeduped("same text", "org-1", "test");
    const org2Promise = service.embedQueryDeduped("same text", "org-2", "test");

    resolveFirst(FAKE_VEC);

    const [vec1, vec2] = await Promise.all([org1Promise, org2Promise]);
    expect(vec1).toEqual(FAKE_VEC);
    expect(vec2).toEqual(FAKE_VEC);
  });

  it("(c) a real orgId is passed through to the usage row — no empty string or placeholder", async () => {
    const { service, usageService } = await buildService();

    await service.embedQuery("test question", "org-real-id-123", "kb.public-rag");

    const params = usageService.track.mock.calls[0]?.[0];
    expect(params).toBeDefined();
    expect(params!.orgId).toBe("org-real-id-123");
    expect(params!.orgId.length).toBeGreaterThan(8);
  });
});
