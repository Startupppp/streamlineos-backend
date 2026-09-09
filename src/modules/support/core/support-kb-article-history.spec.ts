import { HttpStatus } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { SupportKbService } from "./support-kb.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";

jest.mock("../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn().mockResolvedValue(undefined) },
}));

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

const ARTICLE_ID = 42;
const ORG_ID = "org-support-kb";

function makeCurrent(contentRevision: number) {
  return {
    id: ARTICLE_ID,
    slug: "reset-password",
    status: "published",
    publishedAt: new Date("2026-01-01T00:00:00Z"),
    title: "Reset password",
    content: "old body",
    visibility: "internal",
    contentRevision,
  };
}

function makeUpdated(contentRevision: number) {
  return {
    id: ARTICLE_ID,
    orgId: ORG_ID,
    title: "Reset password",
    content: "new body",
    excerpt: null,
    status: "published",
    visibility: "internal",
    contentRevision,
    aclRevision: 1,
  };
}

function chain(result: unknown[]) {
  const node: Record<string, unknown> = {};
  const self = (): unknown => node;
  node.from = self;
  node.innerJoin = self;
  node.where = self;
  node.orderBy = self;
  node.then = (resolve: (rows: unknown[]) => unknown): Promise<unknown> =>
    Promise.resolve(result).then(resolve);
  return node;
}

function makeDb(current: unknown, updateResult: unknown[]) {
  const capturedWheres: unknown[] = [];
  const insertedVersions: unknown[] = [];

  const returningFn = jest.fn().mockResolvedValue(updateResult);
  const whereFn = jest.fn().mockImplementation((w: unknown) => {
    capturedWheres.push(w);
    return { returning: returningFn };
  });
  const updateFn = jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: whereFn }) });

  const selectResults: unknown[][] = [[{ max: 4 }], []];
  const tx = {
    update: updateFn,
    select: jest.fn().mockImplementation(() => chain(selectResults.shift() ?? [])),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((v: unknown) => {
        insertedVersions.push(v);
        return Promise.resolve(undefined);
      }),
    }),
  };

  const db = {
    query: {
      kbArticles: { findFirst: jest.fn().mockResolvedValue(current) },
    },
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as Db;

  return { db, capturedWheres, insertedVersions };
}

const indexing = {} as never;

describe("SupportKbService.updateArticle — history, revision bump and lost-update guard", () => {
  beforeEach(() => jest.clearAllMocks());

  it("snapshots the edit into kb_article_versions with the next version number", async () => {
    const { db, insertedVersions } = makeDb(makeCurrent(7), [makeUpdated(8)]);
    const svc = new SupportKbService(db, indexing);

    await svc.updateArticle(ORG_ID, ARTICLE_ID, { content: "new body" }, "user-9");

    expect(insertedVersions).toHaveLength(1);
    expect(insertedVersions[0]).toMatchObject({
      orgId: ORG_ID,
      articleId: ARTICLE_ID,
      versionNumber: 5,
      content: "new body",
      authorId: "user-9",
    });
  });

  it("bumps content_revision and emits the reindex event when content changes", async () => {
    const { db } = makeDb(makeCurrent(7), [makeUpdated(8)]);
    const svc = new SupportKbService(db, indexing);

    await svc.updateArticle(ORG_ID, ARTICLE_ID, { content: "new body" });

    expect(OutboxWriter.emit).toHaveBeenCalledTimes(1);
    const emitted = jest.mocked(OutboxWriter.emit).mock.calls[0]?.[1];
    expect(emitted).toMatchObject({
      eventType: "kb.content.index",
      aggregateType: "kb_article",
      aggregateId: String(ARTICLE_ID),
      payload: { contentType: "article", contentId: ARTICLE_ID, contentRevision: 8 },
    });
  });

  it("guards the UPDATE with the revision it read — the predicate is in the bound SQL", async () => {
    const { db, capturedWheres } = makeDb(makeCurrent(7), [makeUpdated(8)]);
    const svc = new SupportKbService(db, indexing);

    await svc.updateArticle(ORG_ID, ARTICLE_ID, { content: "new body" });

    const vals = capturedWheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(7);
    expect(vals).toContain(ARTICLE_ID);
    expect(vals).toContain(ORG_ID);
  });

  it("throws 409 STALE_REVISION and writes no version when a concurrent edit won the race", async () => {
    const { db, insertedVersions } = makeDb(makeCurrent(7), []);
    const svc = new SupportKbService(db, indexing);

    let caught: unknown;
    try {
      await svc.updateArticle(ORG_ID, ARTICLE_ID, { content: "new body" });
    } catch (e) {
      caught = e;
    }

    const err = caught as { getStatus?: () => number; getResponse?: () => unknown };
    expect(typeof err.getStatus === "function" ? err.getStatus() : undefined).toBe(HttpStatus.CONFLICT);
    expect(typeof err.getResponse === "function" ? err.getResponse() : undefined).toMatchObject({
      code: "STALE_REVISION",
    });
    expect(insertedVersions).toHaveLength(0);
    expect(OutboxWriter.emit).not.toHaveBeenCalled();
  });

  it("writes no version and emits nothing when only metadata changed", async () => {
    const { db, insertedVersions } = makeDb(makeCurrent(7), [makeUpdated(7)]);
    const svc = new SupportKbService(db, indexing);

    await svc.updateArticle(ORG_ID, ARTICLE_ID, { excerpt: "shorter" });

    expect(insertedVersions).toHaveLength(0);
    expect(OutboxWriter.emit).not.toHaveBeenCalled();
  });
});
