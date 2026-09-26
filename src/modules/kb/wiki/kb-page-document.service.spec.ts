import { ForbiddenException, HttpException, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPagesService } from "./kb-pages.service";
import { KbPageWriterService } from "./kb-page-writer.service";
import { STALE_REVISION_CODE } from "./kb-page-edit.util";

function makeUser(orgId = "org-a") {
  return {
    orgId,
    userId: "u1",
    role: "MEMBER",
    isOrgOwner: false,
    principal: undefined,
  } as never;
}

const BASE_PAGE = {
  id: 1,
  orgId: "org-a",
  isLocked: false,
  trustState: "unverified",
  content: null,
  title: "A page",
  contentRevision: 5,
  aclRevision: 1,
  spaceId: null,
  parentPageId: null,
  sortOrder: null,
  projectId: null,
  icon: null,
  coverImage: null,
  status: "draft",
  contentType: "rich_text",
  visibility: "private",
  publicToken: null,
  publicSlug: null,
  contentText: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  createdByMembershipId: null,
  lastEditedByMembershipId: null,
  deletedByMembershipId: null,
  ownerMembershipId: null,
  verifiedByMembershipId: null,
  createdById: "u1",
  lastEditedById: "u1",
  deletedById: null,
  ownerUserId: null,
  verifiedById: null,
  verifiedUntil: null,
  nextReviewAt: null,
};

function makeDb(opts: {
  currentPage: typeof BASE_PAGE | null;
  updatedPage: typeof BASE_PAGE | null;
  conflictRow?: { contentRevision: number | null; updatedAt: Date; editorName: string | null };
}) {
  const capturedSetValues: Record<string, unknown>[] = [];

  const limitMock = jest.fn().mockResolvedValue(
    opts.conflictRow ? [opts.conflictRow] : [],
  );
  const conflictLeftJoinChain = { where: jest.fn(() => ({ limit: limitMock })) };
  const conflictFromChain = { leftJoin: jest.fn(() => conflictLeftJoinChain) };
  const selectMock = jest.fn(() => ({ from: jest.fn(() => conflictFromChain) }));

  const returningMock = jest.fn().mockResolvedValue(
    opts.updatedPage ? [opts.updatedPage] : [],
  );
  const whereMock = jest.fn(() => ({ returning: returningMock }));
  const setMock = jest.fn((values: Record<string, unknown>) => {
    capturedSetValues.push(values);
    return { where: whereMock };
  });
  const updateMock = jest.fn(() => ({ set: setMock }));

  const insertValuesMock = jest.fn().mockResolvedValue([]);
  const insertMock = jest.fn(() => ({
    values: () => insertValuesMock(),
    onConflictDoNothing: () => Promise.resolve([]),
  }));

  const deleteMock = jest.fn(() => ({ where: jest.fn().mockResolvedValue([]) }));

  const tx = {
    update: updateMock,
    select: selectMock,
    insert: insertMock,
    delete: deleteMock,
    query: { kbPageVersions: { findFirst: jest.fn().mockResolvedValue(null) } },
  };

  const db = {
    query: {
      kbPages: {
        findFirst: jest.fn().mockResolvedValue(opts.currentPage),
      },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as Db;

  return { db, capturedSetValues, setMock };
}

function makeAuth(decision: "allowed" | "forbidden" | "notFound" = "allowed") {
  const resolution =
    decision === "forbidden"
      ? () => Promise.reject(new ForbiddenException("denied"))
      : decision === "notFound"
        ? () => Promise.reject(new NotFoundException("not found"))
        : () => Promise.resolve({ orgId: "org-a", pageId: 1, action: "edit", via: "admin" });

  return {
    assertPageAccess: jest.fn(resolution),
    resolvePageAccess: jest.fn().mockResolvedValue({ outcome: "allowed" }),
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  };
}

function makeService(db: Db, authDecision: "allowed" | "forbidden" | "notFound" = "allowed") {
  return new KbPagesService(
    db,
    { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never,
    makeAuth(authDecision) as never,
    {} as never,
    {} as never,
    new KbPageWriterService({} as never),
  );
}

describe("KbPagesService.update — content vs metadata separation", () => {
  it("(a) metadata-only write: SET clause does not include contentRevision", async () => {
    const updatedPage = { ...BASE_PAGE, title: "New title" };
    const { db, setMock } = makeDb({ currentPage: BASE_PAGE, updatedPage });
    const svc = makeService(db);

    await svc.update(makeUser(), 1, { title: "New title" }, false);

    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("contentRevision" in setArg).toBe(false);
  });

  it("(b) content write: SET clause includes contentRevision expression", async () => {
    const updatedPage = { ...BASE_PAGE, contentRevision: 6 };
    const { db, setMock } = makeDb({ currentPage: BASE_PAGE, updatedPage });
    const svc = makeService(db);

    await svc.update(
      makeUser(),
      1,
      { content: {}, contentText: "", expectedContentRevision: 5 },
      false,
    );

    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("contentRevision" in setArg).toBe(true);
  });
});

describe("KbPagesService.update — optimistic concurrency guard", () => {
  it("(a) current revision: returns the updated page", async () => {
    const updatedPage = { ...BASE_PAGE, contentRevision: 6 };
    const { db } = makeDb({ currentPage: BASE_PAGE, updatedPage });
    const svc = makeService(db);

    const result = await svc.update(
      makeUser(),
      1,
      { content: {}, contentText: "", expectedContentRevision: 5 },
      false,
    );

    expect(result.contentRevision).toBe(6);
  });

  it("(d) stale revision: throws HttpException 409 with code STALE_REVISION", async () => {
    const conflictRow = {
      contentRevision: 7,
      updatedAt: new Date(),
      editorName: "Alice",
    };
    const { db } = makeDb({
      currentPage: BASE_PAGE,
      updatedPage: null,
      conflictRow,
    });
    const svc = makeService(db);

    await expect(
      svc.update(
        makeUser(),
        1,
        { content: {}, contentText: "", expectedContentRevision: 4 },
        false,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: STALE_REVISION_CODE },
    });
  });
});

describe("KbPagesService.update — access control", () => {
  it("(a) edit-allowed: returns updated page without throwing", async () => {
    const updatedPage = { ...BASE_PAGE, title: "Saved" };
    const { db } = makeDb({ currentPage: BASE_PAGE, updatedPage });
    const svc = makeService(db, "allowed");

    await expect(
      svc.update(makeUser(), 1, { title: "Saved" }, false),
    ).resolves.toMatchObject({ title: "Saved" });
  });

  it("(b) edit-denied: propagates ForbiddenException from authorization seam", async () => {
    const { db } = makeDb({ currentPage: BASE_PAGE, updatedPage: BASE_PAGE });
    const svc = makeService(db, "forbidden");

    await expect(
      svc.update(makeUser(), 1, { title: "X" }, false),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("(c) page in another org: propagates NotFoundException from authorization seam", async () => {
    const { db } = makeDb({ currentPage: null, updatedPage: null });
    const svc = makeService(db, "notFound");

    await expect(
      svc.update(makeUser("org-b"), 1, { title: "X" }, false),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
