import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbChatHistoryService } from "./kb-chat-history.service";
import type { KbAskCitationService } from "./kb-ask-citations.service";
import type { KbChatCitation } from "../../../db/schema";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const MEMBERSHIP_ID = 42;

function makeUser(orgId = "org-1"): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "member",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
  };
}

function makeConvChain(rows: object[] = [{ id: 1 }]) {
  return {
    where: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(rows),
    }),
  };
}

function makeMsgChain(rows: object[]) {
  return {
    where: jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

function makeDbForList(msgRows: object[]): Db {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue(makeMsgChain(msgRows)),
    }),
  } as unknown as Db;
}

function makeDbForListMessages(convRows: object[], msgRows: object[]): Db {
  const selectMock = jest
    .fn()
    .mockReturnValueOnce({ from: jest.fn().mockReturnValue(makeConvChain(convRows)) })
    .mockReturnValueOnce({ from: jest.fn().mockReturnValue(makeMsgChain(msgRows)) });
  return { select: selectMock } as unknown as Db;
}

function makeRow(id: number, citations: KbChatCitation[] | null = null) {
  return {
    id,
    role: "assistant" as const,
    content: "Here is the answer",
    citations,
    createdAt: new Date("2026-01-01"),
  };
}

function makeCitationService(visible: KbChatCitation[]): KbAskCitationService {
  return {
    filterStoredCitations: jest.fn().mockResolvedValue(visible),
  } as unknown as KbAskCitationService;
}

const PAGE_CITATION: KbChatCitation = {
  kind: "page",
  pageId: 5,
  title: "Page Title",
  spaceId: 1,
};
const ARTICLE_CITATION: KbChatCitation = {
  kind: "article",
  articleId: 10,
  title: "Article Title",
  slug: "article-slug",
  spaceId: 1,
};
const SOURCE_CITATION: KbChatCitation = {
  kind: "source",
  sourceId: 20,
  title: "Source Title",
  spaceId: 1,
};
const DOC_CITATION: KbChatCitation = {
  kind: "document",
  linkedDocumentId: 30,
  title: "Document Title",
  spaceId: null,
};

describe("KbChatHistoryService — stored citation ACL recheck on conversation reopen", () => {
  const user = makeUser();

  describe("listMessages", () => {
    it("drops a citation whose page is no longer visible when re-opening a conversation", async () => {
      const db = makeDbForListMessages([{ id: 1 }], [makeRow(1, [PAGE_CITATION])]);
      const svc = new KbChatHistoryService(db, makeCitationService([]));
      const result = await svc.listMessages(user, 1, { limit: 20 });
      expect(result.messages[0]?.citations).toBeNull();
    });

    it("retains a citation whose page is still visible when re-opening a conversation", async () => {
      const db = makeDbForListMessages([{ id: 1 }], [makeRow(1, [PAGE_CITATION])]);
      const svc = new KbChatHistoryService(db, makeCitationService([PAGE_CITATION]));
      const result = await svc.listMessages(user, 1, { limit: 20 });
      expect(result.messages[0]?.citations).toEqual([PAGE_CITATION]);
    });

    it("still returns the message and its content when all its citations are filtered out on conversation reopen", async () => {
      const db = makeDbForListMessages([{ id: 1 }], [makeRow(1, [PAGE_CITATION])]);
      const svc = new KbChatHistoryService(db, makeCitationService([]));
      const result = await svc.listMessages(user, 1, { limit: 20 });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.content).toBe("Here is the answer");
    });

    it("drops an article citation when the article is no longer visible (article arm)", async () => {
      const db = makeDbForListMessages([{ id: 1 }], [makeRow(1, [ARTICLE_CITATION])]);
      const svc = new KbChatHistoryService(db, makeCitationService([]));
      const result = await svc.listMessages(user, 1, { limit: 20 });
      expect(result.messages[0]?.citations).toBeNull();
    });

    it("retains a visible article citation (article arm positive control)", async () => {
      const db = makeDbForListMessages([{ id: 1 }], [makeRow(1, [ARTICLE_CITATION])]);
      const svc = new KbChatHistoryService(db, makeCitationService([ARTICLE_CITATION]));
      const result = await svc.listMessages(user, 1, { limit: 20 });
      expect(result.messages[0]?.citations).toEqual([ARTICLE_CITATION]);
    });

    it("drops a source citation when the source is no longer visible (source arm)", async () => {
      const db = makeDbForListMessages([{ id: 1 }], [makeRow(1, [SOURCE_CITATION])]);
      const svc = new KbChatHistoryService(db, makeCitationService([]));
      const result = await svc.listMessages(user, 1, { limit: 20 });
      expect(result.messages[0]?.citations).toBeNull();
    });

    it("retains a visible source citation (source arm positive control)", async () => {
      const db = makeDbForListMessages([{ id: 1 }], [makeRow(1, [SOURCE_CITATION])]);
      const svc = new KbChatHistoryService(db, makeCitationService([SOURCE_CITATION]));
      const result = await svc.listMessages(user, 1, { limit: 20 });
      expect(result.messages[0]?.citations).toEqual([SOURCE_CITATION]);
    });

    it("drops a document citation when the linked document is no longer citable (document arm)", async () => {
      const db = makeDbForListMessages([{ id: 1 }], [makeRow(1, [DOC_CITATION])]);
      const svc = new KbChatHistoryService(db, makeCitationService([]));
      const result = await svc.listMessages(user, 1, { limit: 20 });
      expect(result.messages[0]?.citations).toBeNull();
    });

    it("retains a citable document citation (document arm positive control)", async () => {
      const db = makeDbForListMessages([{ id: 1 }], [makeRow(1, [DOC_CITATION])]);
      const svc = new KbChatHistoryService(db, makeCitationService([DOC_CITATION]));
      const result = await svc.listMessages(user, 1, { limit: 20 });
      expect(result.messages[0]?.citations).toEqual([DOC_CITATION]);
    });

    it("issues one filterStoredCitations call for the whole page not one per message", async () => {
      const rows = [makeRow(1, [PAGE_CITATION]), makeRow(2, [ARTICLE_CITATION])];
      const db = makeDbForListMessages([{ id: 1 }], rows);
      const filterFn = jest.fn().mockResolvedValue([PAGE_CITATION]);
      const citations = { filterStoredCitations: filterFn } as unknown as KbAskCitationService;
      const svc = new KbChatHistoryService(db, citations);
      await svc.listMessages(user, 1, { limit: 20 });
      expect(filterFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("list", () => {
    it("drops a citation whose page is no longer visible when loading global KB history", async () => {
      const db = makeDbForList([makeRow(1, [PAGE_CITATION])]);
      const svc = new KbChatHistoryService(db, makeCitationService([]));
      const result = await svc.list(user, { limit: 20 });
      expect(result.messages[0]?.citations).toBeNull();
    });

    it("retains a citation whose page is still visible when loading global KB history", async () => {
      const db = makeDbForList([makeRow(1, [PAGE_CITATION])]);
      const svc = new KbChatHistoryService(db, makeCitationService([PAGE_CITATION]));
      const result = await svc.list(user, { limit: 20 });
      expect(result.messages[0]?.citations).toEqual([PAGE_CITATION]);
    });

    it("issues one filterStoredCitations call for the whole page not one per message", async () => {
      const rows = [makeRow(1, [PAGE_CITATION]), makeRow(2, [SOURCE_CITATION])];
      const db = makeDbForList(rows);
      const filterFn = jest.fn().mockResolvedValue([PAGE_CITATION]);
      const citations = { filterStoredCitations: filterFn } as unknown as KbAskCitationService;
      const svc = new KbChatHistoryService(db, citations);
      await svc.list(user, { limit: 20 });
      expect(filterFn).toHaveBeenCalledTimes(1);
    });
  });
});
