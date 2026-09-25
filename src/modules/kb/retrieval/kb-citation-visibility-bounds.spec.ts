import { sql } from "drizzle-orm";
import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { KbAccessService } from "../core/kb-access.service";
import { KbEventsService } from "../core/kb-events.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { KbAskService } from "./kb-ask.service";
import { KbCitationVisibilityService } from "./kb-citation-visibility.service";
import { KbSearchService } from "./kb-search.service";
import type { CitedRef } from "./kb-citation-visibility.service";
import { NO_LINKED_DOCUMENTS } from "../../../test/kb-linked-document-ask-source.spec-fixtures";
import { KbLinkedDocumentAskSource } from "../linked-documents/kb-linked-document-ask-source";
import { REDIS } from "../../../common/cache/cache.service";

const user = {
  userId: "user1",
  orgId: "org1",
  role: "member",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
} as never;

function makeDb(rows: { id: number }[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.leftJoin = jest.fn(() => chain);
  chain.where = jest.fn(() => Promise.resolve(rows));
  const select = jest.fn(() => chain);
  const db = {
    select,
    execute: jest.fn().mockResolvedValue([{ one: 1 }]),
    transaction: jest.fn(),
  };
  db.transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  return db;
}

const mockAccess = {
  getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
  getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
  getPrincipalIds: jest.fn().mockResolvedValue({ userId: "user1", roleSlugs: [] }),
  isAdmin: jest.fn().mockResolvedValue(false),
};

const mockSearch = {
  articleOwnerFilterFor: jest.fn().mockResolvedValue(null),
};

const mockAuth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "view", via: "admin" }),
  articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
};

async function makeVisibility(rows: { id: number }[]) {
  const db = makeDb(rows);
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      KbCitationVisibilityService,
      { provide: KbAccessService, useValue: mockAccess },
      { provide: KbSearchService, useValue: mockSearch },
      { provide: KnowledgeAuthorizationService, useValue: mockAuth },
      { provide: DRIZZLE, useValue: db },
    ],
  }).compile();
  return { module, db, service: module.get(KbCitationVisibilityService) };
}

const ids = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

describe("KB citation visibility reads are bounded by their caller", () => {
  beforeEach(() => jest.clearAllMocks());

  async function statementsFor(
    method: "visibleArticles" | "visiblePages" | "visibleSources",
    count: number,
  ): Promise<number> {
    const harness = await makeVisibility(ids(count).map((id) => ({ id })));
    try {
      await harness.service[method](user, ids(count));
      return harness.db.select.mock.calls.length;
    } finally {
      await harness.module.close();
    }
  }

  it.each([
    ["visibleArticles" as const, 1],
    ["visiblePages" as const, 1],
    ["visibleSources" as const, 1],
  ])("%s costs %i statement(s) whether it re-checks 1 citation or 30", async (method, expected) => {
    expect(await statementsFor(method, 1)).toBe(expected);
    expect(await statementsFor(method, 30)).toBe(expected);
  });

  it("partitionVisible costs one pass per cited kind, never one per ref", async () => {
    const refs = (per: number): CitedRef[] => [
      ...ids(per).map((id): CitedRef => ({ kind: "article", id })),
      ...ids(per).map((id): CitedRef => ({ kind: "page", id })),
      ...ids(per).map((id): CitedRef => ({ kind: "source", id })),
    ];

    const one = await makeVisibility(ids(30).map((id) => ({ id })));
    const many = await makeVisibility(ids(30).map((id) => ({ id })));
    try {
      await one.service.partitionVisible(user, refs(1));
      await many.service.partitionVisible(user, refs(10));
      expect(many.db.select.mock.calls.length).toBe(one.db.select.mock.calls.length);
    } finally {
      await one.module.close();
      await many.module.close();
    }
  });

  it("reads only the kinds that were actually cited", async () => {
    const harness = await makeVisibility([{ id: 1 }]);
    try {
      await harness.service.partitionVisible(user, [{ kind: "article", id: 1 }]);
      expect(harness.db.select).toHaveBeenCalledTimes(1);
    } finally {
      await harness.module.close();
    }
  });

  it("consults the canonical authorization seam when checking page visibility", async () => {
    const harness = await makeVisibility([{ id: 1 }]);
    try {
      await harness.service.visiblePages(user, [1]);
      expect(mockAuth.visiblePagePredicate).toHaveBeenCalledWith(expect.anything(), "view");
    } finally {
      await harness.module.close();
    }
  });
});

describe("the ask path caps what it can ever hand the visibility reader", () => {
  it("retrieves at most 6 articles and 4 sources per question", async () => {
    const search = {
      ...mockSearch,
      aclCacheOutcome: jest.fn().mockResolvedValue("bypass"),
      retrieveTopArticles: jest.fn().mockResolvedValue([]),
      retrieveTopSources: jest.fn().mockResolvedValue([]),
      retrieveDocumentPassages: jest.fn().mockResolvedValue([]),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KbAskService,
        { provide: KbLinkedDocumentAskSource, useValue: NO_LINKED_DOCUMENTS },
        { provide: AiGatewayService, useValue: { invokeTextWithUsage: jest.fn() } },
        { provide: KbEventsService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        { provide: KbSearchService, useValue: search },
        { provide: KbAccessService, useValue: mockAccess },
        { provide: KnowledgeAuthorizationService, useValue: mockAuth },
        KbCitationVisibilityService,
        { provide: DRIZZLE, useValue: makeDb([]) },
        { provide: REDIS, useValue: null },
      ],
    }).compile();

    try {
      await module.get(KbAskService).ask(user, { question: "how do I reset my password?" });

      expect(search.retrieveTopArticles).toHaveBeenCalledWith(user, "how do I reset my password?", 6, undefined, undefined);
      expect(search.retrieveTopSources).toHaveBeenCalledWith(user, "how do I reset my password?", 4, undefined);
    } finally {
      await module.close();
    }
  });
});
