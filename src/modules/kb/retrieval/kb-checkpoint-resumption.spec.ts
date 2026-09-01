import { createHash } from "node:crypto";
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
  it("R1: saves a checkpoint for each successfully embedded chunk before a provider failure", async () => {
    const chunks = chunkText(LONG_TEXT);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const embedQuery = jest.fn()
      .mockResolvedValueOnce(new Array(EMBEDDING_DIM).fill(0.1))
      .mockResolvedValueOnce(new Array(EMBEDDING_DIM).fill(0.2))
      .mockRejectedValueOnce(new Error("provider unavailable"));

    const saveCheckpoint = jest.fn().mockResolvedValue(undefined);
    const checkpoint = {
      loadCheckpoints: jest.fn().mockResolvedValue(new Map<number, number[]>()),
      saveCheckpoint,
      clearCheckpoints: jest.fn().mockResolvedValue(undefined),
    };

    const tx = makeTx();
    const db = makeDb(makePage(LONG_TEXT), tx);
    const embeddings = {
      isConfigured: jest.fn().mockReturnValue(true),
      embedQuery,
      toVectorLiteral: jest.fn(),
    };

    const svc = new KbIndexingService(db as never, embeddings as never, checkpoint as never);
    await expect(svc.indexPage("org-1", 99)).rejects.toThrow("provider unavailable");

    const savedIndices = saveCheckpoint.mock.calls.map((args) => args[4] as number);
    expect(savedIndices).toContain(0);
    expect(savedIndices).toContain(1);
    expect(savedIndices).not.toContain(2);
  });

  it("R2: on retry, skips cached chunk indices and calls embedQuery only for the uncached chunk by index", async () => {
    const chunks = chunkText(LONG_TEXT);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const cachedMap = new Map<number, number[]>();
    for (let i = 0; i < chunks.length; i++)
      if (i !== 2) cachedMap.set(i, new Array(EMBEDDING_DIM).fill(i * 0.1));

    const embedQuery = jest.fn().mockResolvedValue(new Array(EMBEDDING_DIM).fill(0.3));
    const checkpoint = {
      loadCheckpoints: jest.fn().mockResolvedValue(cachedMap),
      saveCheckpoint: jest.fn().mockResolvedValue(undefined),
      clearCheckpoints: jest.fn().mockResolvedValue(undefined),
    };

    const tx = makeTx();
    const db = makeDb(makePage(LONG_TEXT), tx);
    const embeddings = {
      isConfigured: jest.fn().mockReturnValue(true),
      embedQuery,
      toVectorLiteral: jest.fn(),
    };

    const svc = new KbIndexingService(db as never, embeddings as never, checkpoint as never);
    await svc.indexPage("org-1", 99);

    expect(embedQuery).toHaveBeenCalledTimes(1);
    const calledWith = embedQuery.mock.calls[0]?.[0] as string;
    expect(calledWith).toBe(chunks[2]);
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

    const embedQuery = jest.fn().mockResolvedValue(new Array(EMBEDDING_DIM).fill(0.9));
    const checkpoint = {
      loadCheckpoints,
      saveCheckpoint: jest.fn().mockResolvedValue(undefined),
      clearCheckpoints: jest.fn().mockResolvedValue(undefined),
    };

    const tx = makeTx();
    const db = makeDb(makePage(newText), tx);
    const embeddings = {
      isConfigured: jest.fn().mockReturnValue(true),
      embedQuery,
      toVectorLiteral: jest.fn(),
    };

    const svc = new KbIndexingService(db as never, embeddings as never, checkpoint as never);
    await svc.indexPage("org-1", 99);

    expect(embedQuery).toHaveBeenCalledTimes(newChunks.length);
  });

  it("R4: clearCheckpoints is called with the tx object so a rolled-back transaction also rolls back checkpoint clearing", async () => {
    let capturedFirstArg: unknown;
    const clearCheckpoints = jest.fn().mockImplementation(async (txArg: unknown) => {
      capturedFirstArg = txArg;
    });

    const checkpoint = {
      loadCheckpoints: jest.fn().mockResolvedValue(new Map<number, number[]>()),
      saveCheckpoint: jest.fn().mockResolvedValue(undefined),
      clearCheckpoints,
    };

    const tx = makeTx();
    const db = makeDb(makePage(LONG_TEXT), tx);
    const embeddings = {
      isConfigured: jest.fn().mockReturnValue(true),
      embedQuery: jest.fn().mockResolvedValue(new Array(EMBEDDING_DIM).fill(0.1)),
      toVectorLiteral: jest.fn(),
    };

    const svc = new KbIndexingService(db as never, embeddings as never, checkpoint as never);
    await svc.indexPage("org-1", 99);

    expect(clearCheckpoints).toHaveBeenCalled();
    expect(capturedFirstArg).toBe(tx);
  });
});
