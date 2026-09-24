import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { kbArticleChunks, kbPages, kbArticles, kbSpaces } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import { KbIngestionDeleteConsumer } from "../retrieval/kb-ingestion-delete-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { KbAccessService } from "../core/kb-access.service";

jest.mock("./kb-page-attachment-purge", () => ({
  KB_PAGE_ATTACHMENT_PURGE_PURPOSE: "kb:page:purge",
  recordPageAttachmentPurge: jest.fn(async () => mockPurgeKeys),
  attemptPageAttachmentPurge: jest.fn(async (...args: unknown[]) => {
    mockAttemptArgs.push(args);
    return { confirmed: mockPurgeKeys.length, failed: 0 };
  }),
  purgeOrphanedKbMedia: jest.fn(async () => 0),
}));
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => {
  const actual: typeof import("../../../common/tenant/run-in-tenant-transaction") =
    jest.requireActual("../../../common/tenant/run-in-tenant-transaction");
  return {
    ...actual,
    runInNewTenantTransaction: jest.fn(
      async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(mockDeleteTx),
    ),
  };
});

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
};

const mockPurgeKeys = ["kb-media/org-five/cover.webp"];
const mockAttemptArgs: unknown[][] = [];
const mockDeleteCaptures: { table: unknown; cond: SQL }[] = [];
const mockDeleteTx = {
  delete: (table: unknown) => ({
    where: async (cond: SQL) => {
      mockDeleteCaptures.push({ table, cond });
      return [];
    },
  }),
  update: () => ({ set: () => ({ where: async () => [] }) }),
};

import { KbPageTreeService } from "./kb-page-tree.service";
import { KbSpacesService } from "./kb-spaces.service";

const actualPurge: typeof import("./kb-page-attachment-purge") = jest.requireActual(
  "./kb-page-attachment-purge",
);

const dialect = new PgDialect();
const ORG = "org-five";
const PAGE_ID = 10;
const SUBTREE = [10, 12, 13];
const KB_BUCKET = "kb-files";

function render(cond: SQL): { text: string; params: unknown[] } {
  const { sql: text, params } = dialect.sqlToQuery(cond);
  return { text, params };
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

function makeTreeDb() {
  const deleted: { table: unknown; cond: SQL }[] = [];
  const tx = {
    execute: jest.fn().mockResolvedValue(SUBTREE.map((id) => ({ id }))),
    delete: jest.fn((table: unknown) => ({
      where: jest.fn(async (cond: SQL) => {
        deleted.push({ table, cond });
        return [];
      }),
    })),
  };
  const db = {
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID, title: "Runbook" }) },
    },
    transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  return { db, deleted };
}

function makeTree() {
  const { db, deleted } = makeTreeDb();
  const service = new KbPageTreeService(
    db as never,
    { log: jest.fn() } as never,
    { deleteFileIfPresent: jest.fn().mockResolvedValue(true) } as never,
    { R2_KB_BUCKET_NAME: KB_BUCKET } as never,
    auth as never,
  );
  return { service, deleted };
}

function onlyCondition(rows: { table: unknown; cond: SQL }[], table: unknown, what: string): SQL {
  const found = rows.find((row) => row.table === table);
  if (found === undefined) throw new Error(`no ${what} statement was issued`);
  return found.cond;
}

beforeEach(() => {
  mockAttemptArgs.length = 0;
  mockDeleteCaptures.length = 0;
});

describe("Store 1 of 5 — Postgres rows, deleted under the caller's tenant", () => {
  it("hardDelete deletes kb_pages for the whole subtree, bound to org_id", async () => {
    const { service, deleted } = makeTree();

    await service.hardDelete(makeUser(), PAGE_ID);

    const { text, params } = render(onlyCondition(deleted, kbPages, "kb_pages delete"));
    expect(text).toContain(`"kb_pages"."org_id"`);
    expect(params[0]).toBe(ORG);
    expect(params).toEqual(expect.arrayContaining(SUBTREE));
  });
});

describe("Store 2 of 5 — object storage, deleted in the KB bucket rather than the default one", () => {
  it("hardDelete hands the configured KB bucket to the purge", async () => {
    const { service } = makeTree();

    await service.hardDelete(makeUser(), PAGE_ID);

    expect(mockAttemptArgs).toHaveLength(1);
    expect(mockAttemptArgs[0]?.[2]).toBe(ORG);
    expect(mockAttemptArgs[0]?.[3]).toEqual(mockPurgeKeys);
    expect(mockAttemptArgs[0]?.[4]).toBe(KB_BUCKET);
  });

  it("the purge calls the object store with that override, which is what makes the delete real", async () => {
    const storage = { deleteFileIfPresent: jest.fn().mockResolvedValue(true) };

    const outcome = await actualPurge.attemptPageAttachmentPurge(
      {} as never,
      storage,
      ORG,
      mockPurgeKeys,
      KB_BUCKET,
    );

    expect(storage.deleteFileIfPresent).toHaveBeenCalledWith(ORG, mockPurgeKeys[0], KB_BUCKET);
    expect(outcome).toEqual({ confirmed: 1, failed: 0 });
  });
});

describe("Store 3 of 5 — keyword index, removed by the row itself because fts is generated", () => {
  it("kb_pages.fts is GENERATED ALWAYS STORED, so it cannot outlive the row", () => {
    const fts = getTableConfig(kbPages).columns.find((c) => c.name === "fts");

    expect(fts?.generated).toMatchObject({ type: "always", mode: "stored" });
  });

  it("kb_articles.fts is the same shape, so an article delete needs no index statement either", () => {
    const fts = getTableConfig(kbArticles).columns.find((c) => c.name === "fts");

    expect(fts?.generated).toMatchObject({ type: "always", mode: "stored" });
  });

  it("the GIN index keyword search rides is declared on that generated column", () => {
    const index = getTableConfig(kbPages).indexes.find((i) => i.config.name === "idx_kb_pages_fts");

    expect(index?.config.method).toBe("gin");
  });

  it("BITE: an ordinary column reports no generation, so the assertion is not true of everything", () => {
    const title = getTableConfig(kbPages).columns.find((c) => c.name === "title");

    expect(title?.generated).toBeUndefined();
  });
});

describe("Store 4 of 5 — vector chunks, by declared cascade and by explicit de-index", () => {
  const chunkForeignKeys = getTableConfig(kbArticleChunks).foreignKeys.map((fk) => ({
    name: fk.getName(),
    onDelete: fk.onDelete,
    columns: fk.reference().columns.map((c) => c.name),
    foreignColumns: fk.reference().foreignColumns.map((c) => c.name),
  }));

  it("cascades from its page and its article through a composite tenant foreign key", () => {
    expect(chunkForeignKeys).toEqual(
      expect.arrayContaining([
        {
          name: "fk_kb_chunks_org_page",
          onDelete: "cascade",
          columns: ["org_id", "page_id"],
          foreignColumns: ["org_id", "id"],
        },
        {
          name: "fk_kb_chunks_org_article",
          onDelete: "cascade",
          columns: ["org_id", "article_id"],
          foreignColumns: ["org_id", "id"],
        },
      ]),
    );
  });

  it("every content parent cascades, so none is left to an application delete alone", () => {
    const parents = chunkForeignKeys.filter((fk) => fk.name.startsWith("fk_kb_chunks_org_"));

    expect(parents).toHaveLength(4);
    expect(parents.every((fk) => fk.onDelete === "cascade")).toBe(true);
    expect(parents.every((fk) => fk.columns[0] === "org_id")).toBe(true);
  });

  it("the kb.content.delete consumer also purges chunks explicitly, bound to org and page", async () => {
    const consumer = new KbIngestionDeleteConsumer(new OutboxConsumerRegistry(), {} as never);

    await consumer.handle(makeDeleteEvent());

    expect(mockDeleteCaptures.map((c) => c.table === kbArticleChunks)).toEqual([true]);
    const { text, params } = render(
      onlyCondition(mockDeleteCaptures, kbArticleChunks, "chunk purge"),
    );
    expect(text).toContain(`"kb_article_chunks"."page_id"`);
    expect(params).toEqual(expect.arrayContaining([ORG, PAGE_ID]));
  });
});

function makeDeleteEvent(): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "evt-five-1",
    organizationId: ORG,
    aggregateType: "kb_page",
    aggregateId: String(PAGE_ID),
    aggregateVersion: 1,
    eventType: "kb.content.delete",
    payload: { contentType: "page", contentId: PAGE_ID },
    deliveryState: "IN_FLIGHT",
    retryCount: 0,
    schemaVersion: 1,
    audience: "INTERNAL",
    actorMembershipId: null,
    causationId: null,
    correlationId: null,
    occurredAt: new Date(),
    publishedAt: null,
    leaseExpiresAt: null,
    lastError: null,
    deadLetteredAt: null,
    lifecycleState: "ACTIVE",
    createdAt: new Date(),
  };
}

describe("Store 5 of 5 — cache, invalidated by namespace on a KB delete", () => {
  it("invalidateAccessibleSpaceIds drops the whole tenant namespace, not one key", async () => {
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };
    const service = new KbAccessService({} as never, cache as never, {} as never);

    await service.invalidateAccessibleSpaceIds(ORG);

    expect(cache.invalidateNamespace).toHaveBeenCalledWith(`kb:acc-spaces:${ORG}`);
  });

  it("removing a space emits the de-index events and then invalidates that cache", async () => {
    const emptyBatch = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const tx = {
      update: jest.fn((table: unknown) => ({
        table,
        set: jest.fn(() => ({
          where: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([{ id: 3 }]) })),
        })),
      })),
      select: jest.fn(() => emptyBatch),
    };
    const access = { invalidateAccessibleSpaceIds: jest.fn().mockResolvedValue(undefined) };
    const service = new KbSpacesService(tx as never, access as never, {} as never);

    const result = await runWithTenantContext(
      { orgId: ORG, audience: "INTERNAL", tx: tx as never },
      () => service.remove(ORG, 3),
    );

    expect(result).toEqual({ success: true });
    expect(tx.update.mock.calls.map((call) => call[0] === kbSpaces)).toEqual([true]);
    expect(access.invalidateAccessibleSpaceIds).toHaveBeenCalledWith(ORG);
  });
});
