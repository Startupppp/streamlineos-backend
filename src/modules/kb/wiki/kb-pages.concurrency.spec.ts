import { HttpStatus, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPagesService } from "./kb-pages.service";
import { updatePageSchema } from "./dto/kb-pages.schemas";

jest.mock("./kb-page-edit.util", () => ({
  ...jest.requireActual("./kb-page-edit.util"),
  snapshotIfNeeded: jest.fn().mockResolvedValue(undefined),
  resyncPageLinks: jest.fn().mockResolvedValue(undefined),
}));

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

const PAGE_ID = 7;
const ORG_ID = "org-occ-test";

function makeUser() {
  return {
    orgId: ORG_ID,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 1 },
  } as never;
}

function makePageRow(contentRevision: number, over: Record<string, unknown> = {}) {
  return {
    id: PAGE_ID,
    orgId: ORG_ID,
    parentPageId: null,
    title: "Test page",
    content: null,
    contentText: null,
    contentRevision,
    aclRevision: 1,
    publicToken: null,
    createdById: "user-1",
    createdByMembershipId: 1,
    isLocked: false,
    trustState: "unverified",
    status: "draft",
    ...over,
  };
}

const LATEST_EDIT = {
  contentRevision: 12,
  updatedAt: new Date("2026-03-04T10:15:00.000Z"),
  editorName: "Priya Raman",
};

function makeDb(pageRow: unknown, updateResult: unknown[], latestEdit: unknown[] = [LATEST_EDIT]) {
  const capturedWheres: unknown[] = [];

  const returningFn = jest.fn().mockResolvedValue(updateResult);
  const whereFn = jest.fn().mockImplementation((w: unknown) => {
    capturedWheres.push(w);
    return { returning: returningFn };
  });
  const setFn = jest.fn().mockReturnValue({ where: whereFn });
  const updateFn = jest.fn().mockReturnValue({ set: setFn });

  const selectFn = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      leftJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((w: unknown) => {
          capturedWheres.push(w);
          return { limit: jest.fn().mockResolvedValue(latestEdit) };
        }),
      }),
    }),
  });

  const tx = {
    update: updateFn,
    select: selectFn,
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
  };

  const db = {
    query: {
      kbPages: {
        findFirst: jest.fn().mockResolvedValue(pageRow),
      },
      kbSpaces: { findFirst: jest.fn().mockResolvedValue(undefined) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as Db;

  return { db, capturedWheres };
}

const notifications = {} as never;
const planLimits = {} as never;

function makeAuth() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: PAGE_ID, action: "edit", via: "admin" }),
  };
}

describe("KbPagesService — optimistic concurrency control", () => {
  beforeEach(() => jest.clearAllMocks());

  it("(a) succeeds and returns the incremented revision when expectedContentRevision matches", async () => {
    const currentRevision = 3;
    const pageRow = makePageRow(currentRevision);
    const updatedRow = { ...pageRow, contentRevision: currentRevision + 1 };
    const { db } = makeDb(pageRow, [updatedRow]);
    const auth = makeAuth();
    const svc = new KbPagesService(db, notifications, planLimits, auth as never, {} as never);

    const result = await svc.update(
      makeUser(),
      PAGE_ID,
      { content: { type: "doc", content: [] }, expectedContentRevision: currentRevision },
      false,
    );

    expect(result.contentRevision).toBe(currentRevision + 1);
  });

  it("(b) throws 409 Conflict when expectedContentRevision is stale and does not write", async () => {
    const pageRow = makePageRow(3);
    const { db, capturedWheres } = makeDb(pageRow, []);
    const auth = makeAuth();
    const svc = new KbPagesService(db, notifications, planLimits, auth as never, {} as never);

    let caught: unknown;
    try {
      await svc.update(
        makeUser(),
        PAGE_ID,
        { content: { type: "doc", content: [] }, expectedContentRevision: 999 },
        false,
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    const err = caught as { status?: number; getStatus?: () => number };
    const status = typeof err.getStatus === "function" ? err.getStatus() : err.status;
    expect(status).toBe(HttpStatus.CONFLICT);

    const vals = capturedWheres.flatMap(w => sqlValues(w));
    expect(vals).not.toContain(3);
  });

  it("(c) rejects a content write that omits expectedContentRevision", () => {
    const parsed = updatePageSchema.safeParse({ content: { type: "doc", content: [] } });

    expect(parsed.success).toBe(false);
    const paths = parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("expectedContentRevision");
  });

  it("(c) a metadata-only edit needs no precondition — content_revision tracks the body alone", () => {
    expect(updatePageSchema.safeParse({ title: "New title" }).success).toBe(true);
    expect(updatePageSchema.safeParse({ status: "published" }).success).toBe(true);
    expect(updatePageSchema.safeParse({ ownerUserId: null }).success).toBe(true);
  });

  it("(c) a rename is not gated on someone else's typing", async () => {
    const currentRevision = 4;
    const pageRow = makePageRow(currentRevision);
    const updatedRow = { ...pageRow, title: "New title" };
    const { db, capturedWheres } = makeDb(pageRow, [updatedRow]);
    const auth = makeAuth();
    const svc = new KbPagesService(db, notifications, planLimits, auth as never, {} as never);

    const result = await svc.update(makeUser(), PAGE_ID, { title: "New title" }, false);

    expect(result.title).toBe("New title");
    const vals = capturedWheres.flatMap(w => sqlValues(w));
    expect(vals).not.toContain(currentRevision);
  });

  it("(c) a stale content write is 409 STALE_REVISION, never NotFoundException", async () => {
    const pageRow = makePageRow(1);
    const { db } = makeDb(pageRow, []);
    const auth = makeAuth();
    const svc = new KbPagesService(db, notifications, planLimits, auth as never, {} as never);

    let caught: unknown;
    try {
      await svc.update(
        makeUser(),
        PAGE_ID,
        { content: { type: "doc", content: [] }, expectedContentRevision: 1 },
        false,
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeInstanceOf(NotFoundException);
    const err = caught as { getStatus?: () => number; getResponse?: () => unknown };
    expect(typeof err.getStatus === "function" ? err.getStatus() : undefined).toBe(HttpStatus.CONFLICT);
    expect(typeof err.getResponse === "function" ? err.getResponse() : undefined).toMatchObject({
      code: "STALE_REVISION",
    });
  });

  it("(c) a conflict names who holds the page now, when they saved it, and the revision to rebase on", async () => {
    const pageRow = makePageRow(1);
    const { db } = makeDb(pageRow, []);
    const auth = makeAuth();
    const svc = new KbPagesService(db, notifications, planLimits, auth as never, {} as never);

    let caught: unknown;
    try {
      await svc.update(
        makeUser(),
        PAGE_ID,
        { content: { type: "doc", content: [] }, expectedContentRevision: 1 },
        false,
      );
    } catch (e) {
      caught = e;
    }

    const err = caught as { getResponse?: () => unknown };
    expect(typeof err.getResponse === "function" ? err.getResponse() : undefined).toMatchObject({
      code: "STALE_REVISION",
      details: {
        currentContentRevision: LATEST_EDIT.contentRevision,
        lastEditedByName: LATEST_EDIT.editorName,
        lastEditedAt: LATEST_EDIT.updatedAt.toISOString(),
      },
    });
  });

  it("(c) a conflict whose page row has since vanished still answers 409 with empty details, never a 500", async () => {
    const pageRow = makePageRow(1);
    const { db } = makeDb(pageRow, [], []);
    const auth = makeAuth();
    const svc = new KbPagesService(db, notifications, planLimits, auth as never, {} as never);

    let caught: unknown;
    try {
      await svc.update(
        makeUser(),
        PAGE_ID,
        { content: { type: "doc", content: [] }, expectedContentRevision: 1 },
        false,
      );
    } catch (e) {
      caught = e;
    }

    const err = caught as { getStatus?: () => number; getResponse?: () => unknown };
    expect(typeof err.getStatus === "function" ? err.getStatus() : undefined).toBe(HttpStatus.CONFLICT);
    expect(typeof err.getResponse === "function" ? err.getResponse() : undefined).toMatchObject({
      details: { currentContentRevision: null, lastEditedByName: null, lastEditedAt: null },
    });
  });

  it("(c) the update response masks the share token for an editor who may not share, exactly as the read does", async () => {
    const currentRevision = 3;
    const pageRow = makePageRow(currentRevision, { createdByMembershipId: 99, createdById: "someone-else" });
    const updatedRow = { ...pageRow, contentRevision: currentRevision + 1, publicToken: "tok_secret" };
    const { db } = makeDb(pageRow, [updatedRow]);
    const auth = makeAuth();
    const svc = new KbPagesService(db, notifications, planLimits, auth as never, {} as never);

    const result = await svc.update(
      makeUser(),
      PAGE_ID,
      { content: { type: "doc", content: [] }, expectedContentRevision: currentRevision },
      false,
    );

    expect(result.publicToken).toBeNull();
    expect(result.contentRevision).toBe(currentRevision + 1);
  });

  it("(c) the update response keeps the share token for the page's own creator", async () => {
    const currentRevision = 3;
    const pageRow = makePageRow(currentRevision);
    const updatedRow = { ...pageRow, contentRevision: currentRevision + 1, publicToken: "tok_secret" };
    const { db } = makeDb(pageRow, [updatedRow]);
    const auth = makeAuth();
    const svc = new KbPagesService(db, notifications, planLimits, auth as never, {} as never);

    const result = await svc.update(
      makeUser(),
      PAGE_ID,
      { content: { type: "doc", content: [] }, expectedContentRevision: currentRevision },
      false,
    );

    expect(result.publicToken).toBe("tok_secret");
  });

  it("update authorizes with action 'edit', not 'view' — a viewer must not mutate content", async () => {
    const currentRevision = 3;
    const pageRow = makePageRow(currentRevision);
    const updatedRow = { ...pageRow, contentRevision: currentRevision + 1 };
    const { db } = makeDb(pageRow, [updatedRow]);
    const auth = makeAuth();
    const svc = new KbPagesService(db, notifications, planLimits, auth as never, {} as never);

    await svc.update(
      makeUser(),
      PAGE_ID,
      { content: { type: "doc", content: [] }, expectedContentRevision: currentRevision },
      false,
    );

    expect(auth.assertPageAccess).toHaveBeenCalledWith(expect.anything(), PAGE_ID, "edit");
  });

  it("(d) WHERE clause carries the revision predicate — atomic guard proven via SQL values", async () => {
    const currentRevision = 5;
    const pageRow = makePageRow(currentRevision);
    const updatedRow = { ...pageRow, contentRevision: currentRevision + 1 };
    const { db, capturedWheres } = makeDb(pageRow, [updatedRow]);
    const auth = makeAuth();
    const svc = new KbPagesService(db, notifications, planLimits, auth as never, {} as never);

    await svc.update(
      makeUser(),
      PAGE_ID,
      { content: { type: "doc", content: [] }, expectedContentRevision: currentRevision },
      false,
    );

    const vals = capturedWheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(currentRevision);
    expect(vals).toContain(PAGE_ID);
    expect(vals).toContain(ORG_ID);
  });
});
