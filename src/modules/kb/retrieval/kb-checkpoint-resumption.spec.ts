import { createHash } from "node:crypto";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { KbIndexingService } from "./kb-indexing.service";
import { chunkText } from "./kb-chunk-utils";

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const EMBEDDING_DIM = 4;
const LONG_SEGMENT = "word ".repeat(350);
const LONG_TEXT = LONG_SEGMENT + LONG_SEGMENT + LONG_SEGMENT;

function makePage(text: string): Record<string, unknown> {
  return {
    status: "published",
    visibility: "org",
    deletedAt: null,
    contentText: text,
    projectId: null,
    createdById: "user-1",
    createdByMembershipId: null,
    aclRevision: 1,
    contentRevision: 1,
  };
}

interface MockTx {
  delete: jest.Mock;
  insert: jest.Mock;
  execute: jest.Mock;
  query: { kbPages: { findFirst: jest.Mock } };
  select: jest.Mock;
}

function makeTx(): MockTx {
  return {
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    execute: jest.fn().mockResolvedValue([]),
    query: { kbPages: { findFirst: jest.fn() } },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
  };
}

function makeDb(page: Record<string, unknown> | null, tx: MockTx) {
  (tx.query.kbPages.findFirst as jest.Mock).mockResolvedValue(page);
  return {
    query: tx.query,
    select: tx.select,
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    transaction: jest.fn().mockImplementation(async (fn: (t: MockTx) => unknown) => fn(tx)),
  };
}

describe("KbIndexingService — embedWithResumption checkpoint lifecycle", () => {
  const okBatch = (fill: number) =>
    jest.fn().mockImplementation(({ texts }: { texts: string[] }) =>
      Promise.resolve({ ok: true, vectors: texts.map(() => new Array(EMBEDDING_DIM).fill(fill) as number[]) }),
    );

  const makeGateway = (embedBatchWithCredit: jest.Mock) => ({
    isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    embedBatchWithCredit,
  });

  it("R1: a provider failure writes no checkpoints and leaves no partial state — the batch is all-or-nothing", async () => {
    const chunks = chunkText(LONG_TEXT);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const embedBatchWithCredit = jest.fn().mockResolvedValue({
      ok: false,
      kind: "provider_unavailable",
      message: "Embedding provider is temporarily unavailable",
      correlationId: "corr-1",
    });

    const saveCheckpoints = jest.fn().mockResolvedValue(undefined);
    const checkpoint = {
      loadCheckpoints: jest.fn().mockResolvedValue(new Map<number, number[]>()),
      saveCheckpoints,
      clearCheckpoints: jest.fn().mockResolvedValue(undefined),
    };

    const tx = makeTx();
    const db = makeDb(makePage(LONG_TEXT), tx);

    const svc = new KbIndexingService(db as never, makeGateway(embedBatchWithCredit) as never, checkpoint as never);
    await expect(svc.indexPage("org-1", 99)).rejects.toThrow(
      "Embedding provider is temporarily unavailable",
    );

    expect(saveCheckpoints).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("R1b: one reservation covers the whole document — the gateway is called once, not once per chunk", async () => {
    const chunks = chunkText(LONG_TEXT);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const embedBatchWithCredit = okBatch(0.1);
    const checkpoint = {
      loadCheckpoints: jest.fn().mockResolvedValue(new Map<number, number[]>()),
      saveCheckpoints: jest.fn().mockResolvedValue(undefined),
      clearCheckpoints: jest.fn().mockResolvedValue(undefined),
    };

    const tx = makeTx();
    const db = makeDb(makePage(LONG_TEXT), tx);

    const svc = new KbIndexingService(db as never, makeGateway(embedBatchWithCredit) as never, checkpoint as never);
    await svc.indexPage("org-1", 99);

    expect(embedBatchWithCredit).toHaveBeenCalledTimes(1);
    expect(embedBatchWithCredit).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", feature: "kb.indexing", charge: true }),
    );
    const call = embedBatchWithCredit.mock.calls[0]?.[0] as { texts: string[] };
    expect(call.texts).toHaveLength(chunks.length);
  });

  it("R2: on retry, skips cached chunk indices and embeds only the uncached chunk by index", async () => {
    const chunks = chunkText(LONG_TEXT);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const cachedMap = new Map<number, number[]>();
    for (let i = 0; i < chunks.length; i++)
      if (i !== 2) cachedMap.set(i, new Array(EMBEDDING_DIM).fill(i * 0.1));

    const embedBatchWithCredit = okBatch(0.3);
    const checkpoint = {
      loadCheckpoints: jest.fn().mockResolvedValue(cachedMap),
      saveCheckpoints: jest.fn().mockResolvedValue(undefined),
      clearCheckpoints: jest.fn().mockResolvedValue(undefined),
    };

    const tx = makeTx();
    const db = makeDb(makePage(LONG_TEXT), tx);

    const svc = new KbIndexingService(db as never, makeGateway(embedBatchWithCredit) as never, checkpoint as never);
    await svc.indexPage("org-1", 99);

    expect(embedBatchWithCredit).toHaveBeenCalledTimes(1);
    const call = embedBatchWithCredit.mock.calls[0]?.[0] as { texts: string[] };
    expect(call.texts).toEqual([chunks[2]]);
  });

  it("R2b: the resumed vector for a cached index is the checkpointed one, in chunk order", async () => {
    const chunks = chunkText(LONG_TEXT);
    const cachedMap = new Map<number, number[]>();
    for (let i = 0; i < chunks.length; i++)
      if (i !== 2) cachedMap.set(i, new Array(EMBEDDING_DIM).fill(i + 1));

    const checkpoint = {
      loadCheckpoints: jest.fn().mockResolvedValue(cachedMap),
      saveCheckpoints: jest.fn().mockResolvedValue(undefined),
      clearCheckpoints: jest.fn().mockResolvedValue(undefined),
    };

    const tx = makeTx();
    const db = makeDb(makePage(LONG_TEXT), tx);
    const insertValues = jest.fn().mockResolvedValue(undefined);
    tx.insert.mockReturnValue({ values: insertValues });

    const svc = new KbIndexingService(
      db as never,
      makeGateway(okBatch(0.7)) as never,
      checkpoint as never,
    );
    await svc.indexPage("org-1", 99);

    const rows = insertValues.mock.calls[0]?.[0] as Array<{ chunkIndex: number; embedding: number[] }>;
    expect(rows).toHaveLength(chunks.length);
    expect(rows[0]?.embedding).toEqual(new Array(EMBEDDING_DIM).fill(1));
    expect(rows[1]?.embedding).toEqual(new Array(EMBEDDING_DIM).fill(2));
    expect(rows[2]?.embedding).toEqual(new Array(EMBEDDING_DIM).fill(0.7));
    expect(rows[3]?.embedding).toEqual(new Array(EMBEDDING_DIM).fill(4));
  });

  it("R3: a content-hash change invalidates the old checkpoints — all new-content chunks are re-embedded", async () => {
    const oldText = LONG_TEXT;
    const newText = LONG_TEXT + " updated";
    const oldHash = sha256(oldText);
    const newHash = sha256(newText);
    expect(oldHash).not.toBe(newHash);

    const oldChunks = chunkText(oldText);
    const newChunks = chunkText(newText);
    expect(newChunks.length).toBeGreaterThanOrEqual(3);

    const staleMap = new Map<number, number[]>();
    for (let i = 0; i < Math.min(2, oldChunks.length); i++)
      staleMap.set(i, new Array(EMBEDDING_DIM).fill(i * 0.1));

    const loadCheckpoints = jest.fn().mockImplementation(
      async (_o: string, _c: string, _id: number, contentHash: string): Promise<Map<number, number[]>> => {
        return contentHash === oldHash ? staleMap : new Map();
      },
    );

    const embedBatchWithCredit = okBatch(0.9);
    const checkpoint = {
      loadCheckpoints,
      saveCheckpoints: jest.fn().mockResolvedValue(undefined),
      clearCheckpoints: jest.fn().mockResolvedValue(undefined),
    };

    const tx = makeTx();
    const db = makeDb(makePage(newText), tx);

    const svc = new KbIndexingService(db as never, makeGateway(embedBatchWithCredit) as never, checkpoint as never);
    await svc.indexPage("org-1", 99);

    const call = embedBatchWithCredit.mock.calls[0]?.[0] as { texts: string[] };
    expect(call.texts).toHaveLength(newChunks.length);
  });

  it("R4: clearCheckpoints is called with the tx object so a rolled-back transaction also rolls back checkpoint clearing", async () => {
    let capturedFirstArg: unknown;
    const clearCheckpoints = jest.fn().mockImplementation(async (txArg: unknown) => {
      capturedFirstArg = txArg;
    });

    const checkpoint = {
      loadCheckpoints: jest.fn().mockResolvedValue(new Map<number, number[]>()),
      saveCheckpoints: jest.fn().mockResolvedValue(undefined),
      clearCheckpoints,
    };

    const tx = makeTx();
    const db = makeDb(makePage(LONG_TEXT), tx);

    const svc = new KbIndexingService(db as never, makeGateway(okBatch(0.1)) as never, checkpoint as never);
    await svc.indexPage("org-1", 99);

    expect(clearCheckpoints).toHaveBeenCalled();
    expect(capturedFirstArg).toBe(tx);
  });

  it("R5: an out-of-credit org fails indexing with a 402 and writes nothing", async () => {
    const embedBatchWithCredit = jest.fn().mockResolvedValue({
      ok: false,
      kind: "quota_exceeded",
      message: "Insufficient AI credits",
      correlationId: "corr-2",
    });
    const saveCheckpoints = jest.fn().mockResolvedValue(undefined);
    const checkpoint = {
      loadCheckpoints: jest.fn().mockResolvedValue(new Map<number, number[]>()),
      saveCheckpoints,
      clearCheckpoints: jest.fn().mockResolvedValue(undefined),
    };

    const tx = makeTx();
    const db = makeDb(makePage(LONG_TEXT), tx);

    const svc = new KbIndexingService(db as never, makeGateway(embedBatchWithCredit) as never, checkpoint as never);
    await expect(svc.indexPage("org-1", 99)).rejects.toBeInstanceOf(InsufficientAiCreditsException);
    expect(saveCheckpoints).not.toHaveBeenCalled();
  });
});
