import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { KbCommentsService } from "./kb-comments.service";
import { KbPageCommentsService } from "../wiki/kb-page-comments.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { AccessService } from "../../access/access.service";
import type { KbAccessService } from "../core/kb-access.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG = "org-kb-comments";
const AUTHOR = "user-author";
const OTHER_MEMBER = "user-other";
const ARTICLE_ID = 11;
const PAGE_ID = 22;
const COMMENT_ID = 33;

function actor(userId: string, membershipId: number): CurrentUserContext {
  return {
    orgId: ORG,
    userId,
    role: "MEMBER",
    isOrgOwner: false,
    principal: humanSessionPrincipal(membershipId, false),
  } as CurrentUserContext;
}

const AUTHOR_ACTOR = actor(AUTHOR, 101);
const OTHER_ACTOR = actor(OTHER_MEMBER, 202);

interface ArticleHarness {
  svc: KbCommentsService;
  viewable: jest.Mock;
  editable: jest.Mock;
  updated: Record<string, unknown>[];
  deletes: number;
}

function makeArticleHarness(options: { isAdmin: boolean }): ArticleHarness {
  const updated: Record<string, unknown>[] = [];
  let deletes = 0;

  const returningRow = [{ id: COMMENT_ID, articleId: ARTICLE_ID, authorId: AUTHOR }];
  const db = {
    query: {
      kbArticleComments: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: COMMENT_ID, authorId: AUTHOR, articleId: ARTICLE_ID }),
      },
    },
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((patch: Record<string, unknown>) => {
        updated.push(patch);
        return { where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(returningRow) }) };
      }),
    }),
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockImplementation(() => {
        deletes += 1;
        return Promise.resolve([]);
      }),
    }),
  };

  const viewable = jest.fn().mockResolvedValue(undefined);
  const editable = jest.fn().mockResolvedValue(undefined);
  const kbAccess = {
    assertArticleViewable: viewable,
    assertArticleEditable: editable,
  } as unknown as KbAccessService;
  const access = { holds: jest.fn().mockResolvedValue(options.isAdmin) } as unknown as AccessService;

  return {
    svc: new KbCommentsService(db as never, kbAccess, access),
    viewable,
    editable,
    updated,
    get deletes() {
      return deletes;
    },
  };
}

interface PageHarness {
  svc: KbPageCommentsService;
  pageLookups: number;
  updated: Record<string, unknown>[];
}

function makePageHarness(options: { visible: boolean; isAdmin: boolean }): PageHarness {
  const updated: Record<string, unknown>[] = [];
  let pageLookups = 0;

  const projectChain = () => {
    const node: Record<string, jest.Mock> = {};
    node.from = jest.fn(() => node);
    node.innerJoin = jest.fn(() => node);
    node.where = jest.fn(() => Promise.resolve([]));
    return node;
  };

  const db = {
    query: {
      kbPageComments: {
        findFirst: jest.fn().mockResolvedValue({ id: COMMENT_ID, authorId: AUTHOR, pageId: PAGE_ID }),
      },
      kbPages: {
        findFirst: jest.fn().mockImplementation(() => {
          pageLookups += 1;
          return Promise.resolve(options.visible ? { id: PAGE_ID } : undefined);
        }),
      },
    },
    select: jest.fn(() => projectChain()),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((patch: Record<string, unknown>) => {
        updated.push(patch);
        return {
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: COMMENT_ID, pageId: PAGE_ID }]),
          }),
        };
      }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  };

  const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationDispatchService;
  const access = { holds: jest.fn().mockResolvedValue(options.isAdmin) } as unknown as AccessService;

  return {
    svc: new KbPageCommentsService(db as never, dispatch, access),
    get pageLookups() {
      return pageLookups;
    },
    updated,
  };
}

describe("KB article comments — the approved permission model, enforced at the data seam", () => {
  it("lets the author edit and delete their own comment while the article stays viewable", async () => {
    const h = makeArticleHarness({ isAdmin: false });

    await h.svc.update(AUTHOR_ACTOR, COMMENT_ID, { content: "edited" });
    await h.svc.remove(AUTHOR_ACTOR, COMMENT_ID);

    expect(h.updated[0]).toMatchObject({ content: "edited" });
    expect(h.deletes).toBe(1);
    expect(h.viewable).toHaveBeenCalledTimes(2);
  });

  it("denies the author the moment the article stops being viewable, on every action", async () => {
    for (const action of ["update", "remove"] as const) {
      const h = makeArticleHarness({ isAdmin: false });
      h.viewable.mockRejectedValue(new NotFoundException("Article not found"));

      const call =
        action === "update"
          ? h.svc.update(AUTHOR_ACTOR, COMMENT_ID, { content: "edited" })
          : h.svc.remove(AUTHOR_ACTOR, COMMENT_ID);

      await expect(call).rejects.toBeInstanceOf(NotFoundException);
      expect(h.updated).toHaveLength(0);
      expect(h.deletes).toBe(0);
    }
  });

  it("refuses a non-author who is not a KB administrator", async () => {
    const h = makeArticleHarness({ isAdmin: false });

    await expect(h.svc.update(OTHER_ACTOR, COMMENT_ID, { content: "hijack" })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(h.svc.remove(OTHER_ACTOR, COMMENT_ID)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.updated).toHaveLength(0);
    expect(h.deletes).toBe(0);
  });

  it("lets a KB administrator moderate someone else's comment", async () => {
    const h = makeArticleHarness({ isAdmin: true });

    await h.svc.update(OTHER_ACTOR, COMMENT_ID, { content: "moderated" });
    await h.svc.remove(OTHER_ACTOR, COMMENT_ID);

    expect(h.updated[0]).toMatchObject({ content: "moderated" });
    expect(h.deletes).toBe(1);
  });

  it("resolves through the editable seam, not the viewable one, so a reader cannot resolve", async () => {
    const h = makeArticleHarness({ isAdmin: false });

    await h.svc.resolve(AUTHOR_ACTOR, COMMENT_ID);
    expect(h.editable).toHaveBeenCalledWith(AUTHOR_ACTOR, ARTICLE_ID);

    const denied = makeArticleHarness({ isAdmin: false });
    denied.editable.mockRejectedValue(new NotFoundException("Article not found"));
    await expect(denied.svc.resolve(AUTHOR_ACTOR, COMMENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(denied.updated).toHaveLength(0);
  });
});

describe("KB page comments — the approved permission model, enforced at the data seam", () => {
  it("re-reads current page visibility on update, delete and resolve", async () => {
    const h = makePageHarness({ visible: true, isAdmin: false });

    await h.svc.update(AUTHOR_ACTOR, COMMENT_ID, { content: "edited" });
    await h.svc.remove(AUTHOR_ACTOR, COMMENT_ID);
    await h.svc.resolve(AUTHOR_ACTOR, COMMENT_ID);

    expect(h.pageLookups).toBe(3);
  });

  it("denies the author once the page is no longer visible to them", async () => {
    const h = makePageHarness({ visible: false, isAdmin: false });

    await expect(h.svc.update(AUTHOR_ACTOR, COMMENT_ID, { content: "edited" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(h.svc.remove(AUTHOR_ACTOR, COMMENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.svc.resolve(AUTHOR_ACTOR, COMMENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.updated).toHaveLength(0);
  });

  it("refuses a non-author who is not a KB administrator, and admits one who is", async () => {
    const stranger = makePageHarness({ visible: true, isAdmin: false });
    await expect(stranger.svc.update(OTHER_ACTOR, COMMENT_ID, { content: "hijack" })).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const moderator = makePageHarness({ visible: true, isAdmin: true });
    await moderator.svc.update(OTHER_ACTOR, COMMENT_ID, { content: "moderated" });
    expect(moderator.updated[0]).toMatchObject({ content: "moderated" });
  });
});
