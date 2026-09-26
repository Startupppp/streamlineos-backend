jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { SupportKbEngagementController } from "./support-kb-engagement.controller";
import { KbArticleReindexService } from "../../kb/retrieval/kb-article-reindex.service";
import type { KbIndexingService } from "../../kb/retrieval/kb-indexing.service";
import type { KbAttachmentIndexingService } from "../../kb/retrieval/kb-attachment-indexing.service";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-reindex-conn-release";
const ARTICLE_ID = 7;

function transactionMock(): jest.Mock {
  return jest.requireMock<{ runInTenantTransaction: jest.Mock }>(
    "../../../common/tenant/run-in-tenant-transaction",
  ).runInTenantTransaction;
}

interface DepthTrace {
  service: KbArticleReindexService;
  depthAt: Map<string, number>;
  runInTenantTransaction: jest.Mock;
}

function traceDepth(): DepthTrace {
  const depthAt = new Map<string, number>();
  let depth = 0;
  const record = (step: string): void => {
    depthAt.set(step, depth);
  };

  const mock = transactionMock();
  mock.mockImplementation(
    async (_db: unknown, fn: () => Promise<unknown>) => {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
      }
    },
  );

  const selectChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockImplementation(function (this: unknown) {
      record("dbRead");
      return this;
    }),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    then: jest.fn().mockImplementation(
      (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown): Promise<unknown> =>
        Promise.resolve([{ chunks: 0 }]).then(resolve, reject),
    ),
  };

  const db = {
    select: jest.fn().mockReturnValue(selectChain),
    query: {
      kbPages: {
        findFirst: jest.fn().mockImplementation(() => {
          record("articleLookup");
          return Promise.resolve({ id: ARTICLE_ID });
        }),
      },
      kbPageAttachments: {
        findMany: jest.fn().mockImplementation(() => {
          record("attachmentLookup");
          return Promise.resolve([]);
        }),
      },
    },
  } as unknown as Db;

  const indexing = {
    indexArticle: jest.fn().mockImplementation(() => {
      record("indexArticle");
      return Promise.resolve();
    }),
  } as unknown as KbIndexingService;

  const attachmentIndexing = {
    indexAttachment: jest.fn().mockResolvedValue({ warning: null }),
  } as unknown as KbAttachmentIndexingService;

  const service = new KbArticleReindexService(db, indexing, attachmentIndexing);

  return { service, depthAt, runInTenantTransaction: mock };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe("SupportKbEngagementController — reindex routes opt out of the ambient tenant transaction", () => {
  it("reindexArticle carries @NoTenantTransaction() so indexing never holds a pooled connection through the embedding provider's latency", () => {
    const handler: unknown = Reflect.get(SupportKbEngagementController.prototype, "reindexArticle");
    expect(typeof handler).toBe("function");
    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION, Object(handler))).toBe(true);
  });

  it("reindexAll carries @NoTenantTransaction() so a batch reindex never holds a pooled connection through multiple embedding calls", () => {
    const handler: unknown = Reflect.get(SupportKbEngagementController.prototype, "reindexAll");
    expect(typeof handler).toBe("function");
    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION, Object(handler))).toBe(true);
  });
});

describe("KbArticleReindexService.reindexArticle — pooled connection is not held across the embedding call", () => {
  it("runs indexArticle with no transaction open because the AI embedding call does not touch the database", async () => {
    const { service, depthAt } = traceDepth();
    await service.reindexArticle(ORG, ARTICLE_ID);
    expect(depthAt.get("indexArticle")).toBe(0);
  });

  it("reads the article existence check inside a transaction so the route opt-out never issues a statement without a tenant GUC", async () => {
    const { service, depthAt } = traceDepth();
    await service.reindexArticle(ORG, ARTICLE_ID);
    expect(depthAt.get("articleLookup")).toBe(1);
  });

  it("opens at least two short transactions for DB reads, releasing the connection before and after indexArticle", async () => {
    const { service, runInTenantTransaction: txMock } = traceDepth();
    await service.reindexArticle(ORG, ARTICLE_ID);
    expect(txMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of txMock.mock.calls) {
      expect(call[2]).toEqual({ orgId: ORG });
    }
  });
});

describe("KbArticleReindexService.reindexAll — DB reads are wrapped in explicit tenant transactions", () => {
  it("wraps the article list query in a tenant transaction so it has a GUC even when called from a @NoTenantTransaction() route", async () => {
    const { service, runInTenantTransaction: txMock } = traceDepth();
    await service.reindexAll(ORG, 0);
    expect(txMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      { orgId: ORG },
    );
  });

  it("wraps both the article list and the total-chunks count in separate transactions rather than one spanning the whole batch", async () => {
    const { service, runInTenantTransaction: txMock } = traceDepth();
    await service.reindexAll(ORG, 0);
    expect(txMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
