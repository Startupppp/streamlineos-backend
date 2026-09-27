import "reflect-metadata";
import { KbPagesService } from "./kb-pages.service";
import { KbPageWriterService } from "./kb-page-writer.service";

jest.mock("./kb-page-share-visibility", () => ({
  withoutUnsharedToken: (_user: unknown, page: unknown) => page,
}));

const ORG_ID = "org-update-writer-delegation";
const PAGE_ID = 11;

function makeUser() {
  return {
    orgId: ORG_ID,
    userId: "user-1",
    isOrgOwner: false,
    role: "member" as const,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: { kind: "human-session" as const, membershipId: 1, isOrgOwner: false },
  };
}

const CURRENT_PAGE = {
  id: PAGE_ID,
  isLocked: false,
  trustState: "unverified" as const,
  content: null,
};

const RETURNED_PAGE = {
  id: PAGE_ID,
  orgId: ORG_ID,
  title: "Updated",
  slug: null,
  content: null,
  contentText: "hello",
  contentRevision: 2,
  aclRevision: 1,
  spaceId: null,
  categoryId: null,
  parentPageId: null,
  sortOrder: 100,
  status: "draft" as const,
  contentType: "rich_text" as const,
  icon: null,
  coverImage: null,
  visibility: "workspace" as const,
  isLocked: false,
  trustState: "unverified" as const,
  ownerUserId: null,
  ownerMembershipId: null,
  publicToken: null,
  publicTokenExpiresAt: null,
  publicSlug: null,
  projectId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdById: "user-1",
  createdByMembershipId: null,
  lastEditedById: "user-1",
  lastEditedByMembershipId: null,
  deletedAt: null,
  deletedById: null,
  deletedByMembershipId: null,
  verifiedById: null,
  verifiedByMembershipId: null,
  verifiedUntil: null,
  nextReviewAt: null,
};

function makeDb() {
  const returning = jest.fn().mockResolvedValue([RETURNED_PAGE]);
  const tx = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning }),
      }),
    }),
  };
  return {
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue(CURRENT_PAGE) },
      kbSpaces: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };
}

function makeAuth() {
  return {
    assertPageAccess: jest.fn().mockResolvedValue(undefined),
    resolvePageAccess: jest.fn().mockResolvedValue({ outcome: "allowed" }),
    visiblePagePredicate: jest.fn(),
  };
}

function makeService(
  db: ReturnType<typeof makeDb>,
  writer: KbPageWriterService,
): KbPagesService {
  return new KbPagesService(
    db as never,
    {} as never,
    makeAuth() as never,
    {} as never,
    { log: jest.fn() } as never,
    writer,
  );
}

describe("KbPagesService.update — writer delegation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("calls writer.commitPageChange when content changes so the updated text is re-indexed and reaches search and Ask", async () => {
    const db = makeDb();
    const writer = new KbPageWriterService({} as never);
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = makeService(db, writer);

    await svc.update(
      makeUser() as never,
      PAGE_ID,
      { content: { type: "doc", content: [] } as never, contentText: "hello" },
      false,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        page: expect.objectContaining({ id: PAGE_ID }),
      }),
    );
  });

  it("does not call writer.commitPageChange when only metadata (title) changes, proving the spy would catch a call if one occurred", async () => {
    const db = makeDb();
    const writer = new KbPageWriterService({} as never);
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = makeService(db, writer);

    await svc.update(makeUser() as never, PAGE_ID, { title: "Renamed" }, false);

    expect(spy).not.toHaveBeenCalled();
  });

  it("calls writer.commitPageChange when spaceId changes so the ACL revision is re-indexed after visibility moves to a new space", async () => {
    const db = makeDb();
    const writer = new KbPageWriterService({} as never);
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = makeService(db, writer);

    await svc.update(makeUser() as never, PAGE_ID, { spaceId: 5 }, false);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG_ID }),
    );
  });
});
