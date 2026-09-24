import { HttpStatus } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
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
const OLD_DOCUMENT = { type: "doc", content: [{ type: "p", children: [{ text: "old body" }] }] };

function makeUser() {
  return {
    orgId: ORG_ID,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 3, isOrgOwner: false },
  } as never;
}

function makePageRow(contentRevision: number) {
  return {
    id: ARTICLE_ID,
    orgId: ORG_ID,
    spaceId: 1,
    categoryId: null,
    title: "Reset your password",
    slug: "reset-your-password",
    excerpt: null,
    content: OLD_DOCUMENT,
    contentText: "old body",
    status: "published",
    visibility: "org",
    createdById: "user-1",
    ownerMembershipId: 3,
    trustState: "unverified",
    verifiedUntil: null,
    views: 0,
    helpfulCount: 0,
    notHelpfulCount: 0,
    seoTitle: null,
    seoDescription: null,
    reviewIntervalDays: null,
    publishedAt: new Date("2026-01-01T00:00:00Z"),
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    aclRevision: 1,
    contentRevision,
  };
}

function thenable(rows: unknown[]): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  const self = (): unknown => node;
  node.from = self;
  node.innerJoin = self;
  node.leftJoin = self;
  node.where = self;
  node.orderBy = self;
  node.limit = self;
  node.then = (resolve: (value: unknown[]) => unknown): Promise<unknown> =>
    Promise.resolve(rows).then(resolve);
  return node;
}

function makeDb(currentRow: unknown, updateResult: unknown[]) {
  const capturedWheres: SQL[] = [];
  const insertedVersions: unknown[] = [];

  const returningFn = jest.fn().mockResolvedValue(updateResult);
  const whereFn = jest.fn().mockImplementation((w: SQL) => {
    capturedWheres.push(w);
    return { returning: returningFn };
  });
  const setFn = jest.fn().mockReturnValue({ where: whereFn });
  const updateFn = jest.fn().mockReturnValue({ set: setFn });

  const txSelectResults: unknown[][] = [[{ max: 2 }], []];
  const tx = {
    update: updateFn,
    select: jest.fn().mockImplementation(() => thenable(txSelectResults.shift() ?? [])),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((v: unknown) => {
        insertedVersions.push(v);
        return Promise.resolve(undefined);
      }),
    }),
  };

  const db = {
    select: jest.fn().mockImplementation(() => thenable(currentRow === null ? [] : [currentRow])),
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
    const row = makePageRow(currentRevision);
    const updatedRow = {
      ...row,
      content: { type: "doc", content: [{ type: "p", children: [{ text: "new body" }] }] },
      contentText: "new body",
      contentRevision: currentRevision + 1,
    };
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
      pageId: ARTICLE_ID,
      versionNumber: 3,
      contentText: "new body",
    });
  });

  it("throws 409 STALE_REVISION and writes no version when the revision is stale", async () => {
    const row = makePageRow(6);
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
    const row = makePageRow(currentRevision);
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
    expect(vals).toContain("support_article");
  });

  it("runs a guarded UPDATE even when the caller changed no article column", async () => {
    const currentRevision = 6;
    const row = makePageRow(currentRevision);
    const { db, capturedWheres, updateFn } = makeDb(row, [row]);
    const svc = new KbArticlesService(db, access, events);

    await svc.update(makeUser(), ARTICLE_ID, { expectedContentRevision: currentRevision });

    expect(updateFn).toHaveBeenCalledTimes(1);
    const vals = capturedWheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(currentRevision);
  });
});
