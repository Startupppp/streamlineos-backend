import { HttpStatus } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { KbArticlesService } from "./kb-articles.service";
import { updateArticleSchema } from "../core/dto/kb.schemas";

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

const ARTICLE_ID = 11;
const ORG_ID = "org-article-occ";

function makeUser() {
  return {
    orgId: ORG_ID,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 3, isOrgOwner: false },
  } as never;
}

function makeArticleRow(contentRevision: number) {
  return {
    id: ARTICLE_ID,
    orgId: ORG_ID,
    title: "Reset your password",
    slug: "reset-your-password",
    excerpt: null,
    content: "old body",
    contentText: "old body",
    status: "published",
    visibility: "internal",
    publishedAt: new Date("2026-01-01T00:00:00Z"),
    contentRevision,
    aclRevision: 1,
  };
}

function selectChain(result: unknown[]) {
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

function makeDb(articleRow: unknown, updateResult: unknown[]) {
  const capturedWheres: unknown[] = [];
  const insertedVersions: unknown[] = [];

  const returningFn = jest.fn().mockResolvedValue(updateResult);
  const whereFn = jest.fn().mockImplementation((w: unknown) => {
    capturedWheres.push(w);
    return { returning: returningFn };
  });
  const setFn = jest.fn().mockReturnValue({ where: whereFn });
  const updateFn = jest.fn().mockReturnValue({ set: setFn });

  const selectResults: unknown[][] = [[{ max: 2 }], []];
  const tx = {
    update: updateFn,
    select: jest.fn().mockImplementation(() => selectChain(selectResults.shift() ?? [])),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((v: unknown) => {
        insertedVersions.push(v);
        return Promise.resolve(undefined);
      }),
    }),
  };

  const db = {
    query: {
      kbArticles: { findFirst: jest.fn().mockResolvedValue(articleRow) },
    },
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as Db;

  return { db, capturedWheres, insertedVersions, updateFn };
}

const access = { assertArticleEditable: jest.fn().mockResolvedValue(undefined) } as never;
const events = {} as never;

describe("KbArticlesService — optimistic concurrency control", () => {
  beforeEach(() => jest.clearAllMocks());

  it("rejects an update body that omits expectedContentRevision", () => {
    const parsed = updateArticleSchema.safeParse({ content: "new body" });

    expect(parsed.success).toBe(false);
    const paths = parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("expectedContentRevision");
  });

  it("succeeds on a matching revision and snapshots the new content into history", async () => {
    const currentRevision = 6;
    const row = makeArticleRow(currentRevision);
    const updatedRow = { ...row, content: "new body", contentRevision: currentRevision + 1 };
    const { db, insertedVersions } = makeDb(row, [updatedRow]);
    const svc = new KbArticlesService(db, access, events);

    const result = await svc.update(makeUser(), ARTICLE_ID, {
      content: "new body",
      expectedContentRevision: currentRevision,
    });

    expect(result.contentRevision).toBe(currentRevision + 1);
    expect(insertedVersions).toHaveLength(1);
    expect(insertedVersions[0]).toMatchObject({
      orgId: ORG_ID,
      articleId: ARTICLE_ID,
      versionNumber: 3,
      content: "new body",
    });
  });

  it("throws 409 STALE_REVISION and writes no version when the revision is stale", async () => {
    const row = makeArticleRow(6);
    const { db, insertedVersions } = makeDb(row, []);
    const svc = new KbArticlesService(db, access, events);

    let caught: unknown;
    try {
      await svc.update(makeUser(), ARTICLE_ID, { content: "new body", expectedContentRevision: 999 });
    } catch (e) {
      caught = e;
    }

    const err = caught as { getStatus?: () => number; getResponse?: () => unknown };
    expect(typeof err.getStatus === "function" ? err.getStatus() : undefined).toBe(HttpStatus.CONFLICT);
    expect(typeof err.getResponse === "function" ? err.getResponse() : undefined).toMatchObject({
      code: "STALE_REVISION",
    });
    expect(insertedVersions).toHaveLength(0);
  });

  it("puts the revision predicate in the UPDATE's WHERE — proven from the bound SQL values", async () => {
    const currentRevision = 6;
    const row = makeArticleRow(currentRevision);
    const { db, capturedWheres } = makeDb(row, [{ ...row, contentRevision: currentRevision + 1 }]);
    const svc = new KbArticlesService(db, access, events);

    await svc.update(makeUser(), ARTICLE_ID, {
      content: "new body",
      expectedContentRevision: currentRevision,
    });

    const vals = capturedWheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(currentRevision);
    expect(vals).toContain(ARTICLE_ID);
    expect(vals).toContain(ORG_ID);
  });

  it("runs a guarded UPDATE even when the caller changed no article column", async () => {
    const currentRevision = 6;
    const row = makeArticleRow(currentRevision);
    const { db, capturedWheres, updateFn } = makeDb(row, [row]);
    const svc = new KbArticlesService(db, access, events);

    await svc.update(makeUser(), ARTICLE_ID, { expectedContentRevision: currentRevision });

    expect(updateFn).toHaveBeenCalledTimes(1);
    const vals = capturedWheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(currentRevision);
  });
});
