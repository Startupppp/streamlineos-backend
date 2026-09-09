import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { KbIndexingService } from "./kb-indexing.service";
import { chunkText, sha256 } from "./kb-chunk-utils";
import { embedChunksWithResumption } from "./kb-embedding-resumption";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import { Logger } from "@nestjs/common";

const ORG = "org-redelivery";
const PAGE_ID = 501;
const EMBEDDING_DIM = 1536;
const CONTENT_HASH = "b".repeat(64);
const dialect = new PgDialect();

const BODY = "onboarding runbook ".repeat(400);
const OTHER_BODY = "incident response playbook ".repeat(400);

interface PageFixture {
  status: string;
  visibility: string;
  deletedAt: Date | null;
  contentText: string;
  projectId: number | null;
  createdById: string | null;
  createdByMembershipId: number | null;
  aclRevision: number;
  contentRevision: number;
}

function makePage(): PageFixture {
  return {
    status: "published",
    visibility: "org",
    deletedAt: null,
    contentText: BODY,
    projectId: null,
    createdById: "user-7",
    createdByMembershipId: null,
    aclRevision: 1,
    contentRevision: 1,
  };
}

function makeWorld(page: PageFixture) {
  const stored: Record<string, unknown>[] = [];
  const order: string[] = [];

  const chunkState = () => {
    const first = stored[0];
    if (first === undefined) return [];
    return [
      {
        contentHash: first.contentHash,
        pageVisibility: first.pageVisibility,
        pageProjectId: first.pageProjectId,
        pageCreatedById: first.pageCreatedById,
        pageCreatedByMembershipId: first.pageCreatedByMembershipId,
        aclRevision: first.aclRevision,
      },
    ];
  };

  const tx = {
    query: { kbPages: { findFirst: jest.fn(async () => page) } },
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({ limit: jest.fn(async () => chunkState()) })),
      })),
    })),
    delete: jest.fn(() => ({
      where: jest.fn(async () => {
        order.push("delete");
        stored.length = 0;
        return [];
      }),
    })),
    insert: jest.fn(() => ({
      values: jest.fn(async (rows: Record<string, unknown>[]) => {
        order.push(`insert:${rows.length}`);
        stored.push(...rows);
        return [];
      }),
    })),
    update: jest.fn(() => ({
      set: jest.fn((values: Record<string, unknown>) => ({
        where: jest.fn(async () => {
          order.push("acl-update");
          for (const row of stored) Object.assign(row, values);
          return [];
        }),
      })),
    })),
  };

  return { tx, stored, order };
}

function makeGateway() {
  return {
    isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    embedBatchWithCredit: jest.fn(async ({ texts }: { texts: string[] }) => ({
      ok: true,
      vectors: texts.map(() => new Array<number>(EMBEDDING_DIM).fill(0.1)),
    })),
  };
}

const makeCheckpoint = () => ({
  loadCheckpoints: jest.fn().mockResolvedValue(new Map<number, number[]>()),
  saveCheckpoints: jest.fn().mockResolvedValue(undefined),
  clearCheckpoints: jest.fn().mockResolvedValue(undefined),
});

describe("KB re-delivery does not double-charge the embedding provider", () => {
  function boot(page: PageFixture) {
    const world = makeWorld(page);
    const gateway = makeGateway();
    const service = new KbIndexingService(
      world.tx as never,
      gateway as never,
      makeCheckpoint() as never,
    );
    const index = () =>
      runWithTenantContext({ orgId: ORG, audience: "INTERNAL", tx: world.tx as never }, () =>
        service.indexPage(ORG, PAGE_ID),
      );
    return { ...world, gateway, index };
  }

  it("the first delivery embeds the body once and stores one row per chunk", async () => {
    const { gateway, stored, index } = boot(makePage());

    const written = await index();

    expect(gateway.embedBatchWithCredit).toHaveBeenCalledTimes(1);
    expect(written).toBe(chunkText(BODY).length);
    expect(stored).toHaveLength(chunkText(BODY).length);
    expect(stored.every((row) => row.contentHash === sha256(BODY))).toBe(true);
  });

  it("an identical re-delivery performs ZERO gateway embed calls and writes no second copy", async () => {
    const { gateway, stored, order, index } = boot(makePage());

    await index();
    const afterFirst = stored.length;
    const callsAfterFirst = gateway.embedBatchWithCredit.mock.calls.length;
    order.length = 0;

    await index();

    expect(gateway.embedBatchWithCredit).toHaveBeenCalledTimes(callsAfterFirst);
    expect(stored).toHaveLength(afterFirst);
    expect(order).toEqual([]);
  });

  it("three deliveries of the same document still cost one embed batch", async () => {
    const { gateway, stored, index } = boot(makePage());

    await index();
    await index();
    await index();

    expect(gateway.embedBatchWithCredit).toHaveBeenCalledTimes(1);
    expect(stored).toHaveLength(chunkText(BODY).length);
  });

  it("changed content DOES re-embed, and replaces the rows rather than appending them", async () => {
    const page = makePage();
    const { gateway, stored, order, index } = boot(page);

    await index();
    order.length = 0;
    page.contentText = OTHER_BODY;

    await index();

    expect(gateway.embedBatchWithCredit).toHaveBeenCalledTimes(2);
    expect(stored).toHaveLength(chunkText(OTHER_BODY).length);
    expect(stored.every((row) => row.contentHash === sha256(OTHER_BODY))).toBe(true);
    expect(order).toEqual(["delete", `insert:${chunkText(OTHER_BODY).length}`]);
  });

  it("an ACL-only change updates the stored chunk ACL without paying for a re-embed", async () => {
    const page = makePage();
    const { gateway, stored, order, index } = boot(page);

    await index();
    order.length = 0;
    page.aclRevision = 2;

    await index();

    expect(gateway.embedBatchWithCredit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["acl-update"]);
    expect(stored.every((row) => row.aclRevision === 2)).toBe(true);
  });
});

describe("embedChunksWithResumption charges only for the chunks no checkpoint covers", () => {
  const chunks = ["alpha", "beta", "gamma"];
  const logger = new Logger("kb-redelivery-spec");

  function deps(cached: Map<number, number[]>) {
    const aiGateway = makeGateway();
    const checkpoint = {
      loadCheckpoints: jest.fn().mockResolvedValue(cached),
      saveCheckpoints: jest.fn().mockResolvedValue(undefined),
      clearCheckpoints: jest.fn().mockResolvedValue(undefined),
    };
    return { aiGateway, checkpoint };
  }

  it("makes no provider call at all when every chunk is already checkpointed", async () => {
    const cached = new Map(chunks.map((_c, i) => [i, [i]]));
    const { aiGateway, checkpoint } = deps(cached);

    const vectors = await embedChunksWithResumption(
      { aiGateway: aiGateway as never, checkpoint: checkpoint as never, logger },
      { orgId: ORG, contentType: "page", contentId: PAGE_ID, contentHash: CONTENT_HASH, chunks },
    );

    expect(aiGateway.embedBatchWithCredit).not.toHaveBeenCalled();
    expect(checkpoint.saveCheckpoints).not.toHaveBeenCalled();
    expect(vectors).toEqual([[0], [1], [2]]);
  });

  it("charges only for the uncovered tail after an interrupted run", async () => {
    const { aiGateway, checkpoint } = deps(new Map([[0, [9]]]));

    await embedChunksWithResumption(
      { aiGateway: aiGateway as never, checkpoint: checkpoint as never, logger },
      { orgId: ORG, contentType: "page", contentId: PAGE_ID, contentHash: CONTENT_HASH, chunks },
    );

    expect(aiGateway.embedBatchWithCredit).toHaveBeenCalledTimes(1);
    const call = aiGateway.embedBatchWithCredit.mock.calls[0]?.[0];
    expect(call?.texts).toEqual(["beta", "gamma"]);
  });
});

interface CheckpointHashProbe {
  saved: unknown;
  lookedUp: unknown;
}

const probeInserts: Record<string, unknown>[][] = [];
const probeWheres: SQL[] = [];

const probeTx = {
  insert: () => ({
    values: (rows: Record<string, unknown>[]) => {
      probeInserts.push(rows);
      return { onConflictDoUpdate: () => Promise.resolve([]) };
    },
  }),
  select: () => ({
    from: () => ({
      where: (cond: SQL) => {
        probeWheres.push(cond);
        return Promise.resolve([]);
      },
    }),
  }),
};

async function checkpointHashProbe(model: string): Promise<CheckpointHashProbe> {
  probeInserts.length = 0;
  probeWheres.length = 0;

  await jest.isolateModulesAsync(async () => {
    jest.doMock("../../ai/core/providers/embeddings.service", () => ({ EMBEDDING_MODEL: model }));
    jest.doMock("../../../common/tenant/run-in-tenant-transaction", () => ({
      runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(probeTx),
      runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn(probeTx),
    }));
    const mod: typeof import("./kb-ingestion-checkpoint.service") = await import(
      "./kb-ingestion-checkpoint.service"
    );
    const service = new mod.KbIngestionCheckpointService({} as never);
    await service.saveCheckpoints(ORG, "page", PAGE_ID, CONTENT_HASH, [
      { chunkIndex: 0, content: "alpha", embedding: [0.1] },
    ]);
    await service.loadCheckpoints(ORG, "page", PAGE_ID, CONTENT_HASH);
  });

  const where = probeWheres[0];
  if (where === undefined) throw new Error("loadCheckpoints issued no predicate");
  const params = dialect.sqlToQuery(where).params;
  return { saved: probeInserts[0]?.[0]?.contentHash, lookedUp: params[params.length - 1] };
}

describe("A changed embedding model re-embeds instead of reusing an old vector space", () => {
  let small: CheckpointHashProbe;
  let large: CheckpointHashProbe;

  beforeAll(async () => {
    small = await checkpointHashProbe("text-embedding-3-small");
    large = await checkpointHashProbe("text-embedding-3-large");
  }, 60_000);

  it("looks a checkpoint up under the hash the same model stored", () => {
    expect(small.lookedUp).toBe(small.saved);
    expect(large.lookedUp).toBe(large.saved);
  });

  it("stores something other than the caller's content hash, which is what scopes it", () => {
    expect(small.saved).not.toBe(CONTENT_HASH);
    expect(String(small.saved)).toHaveLength(64);
  });

  it("cannot find a checkpoint the previous model wrote, so the retry pays for a re-embed", () => {
    expect(large.lookedUp).not.toBe(small.saved);
    expect(small.lookedUp).not.toBe(large.saved);
  });
});
