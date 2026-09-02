import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ACCESSIBLE = [42];

jest.mock("../retrieval/kb-project-access.util", () => ({
  getAccessibleProjectIds: jest.fn().mockResolvedValue(ACCESSIBLE),
}));
jest.mock("./kb-project-access.util", () => ({
  getAccessibleProjectIds: jest.fn().mockResolvedValue(ACCESSIBLE),
}));

const pageVisibleTo = jest.fn().mockReturnValue({ marker: "predicate" });
jest.mock("../retrieval/kb-page-visibility", () => ({
  pageVisibleTo: (...args: unknown[]) => pageVisibleTo(...args),
}));
jest.mock("./kb-page-visibility", () => ({
  pageVisibleTo: (...args: unknown[]) => pageVisibleTo(...args),
  visibleTo: (...args: unknown[]) => pageVisibleTo(...args),
}));

import { KbAnalyticsService } from "../help-centre/kb-analytics.service";
import { KbPageAiService } from "../wiki/kb-page-ai.service";
import { KbPageCommentsService } from "../wiki/kb-page-comments.service";
import { KbPageRecordLinksService } from "../wiki/kb-page-record-links.service";

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  isOrgOwner: false,
  role: "member",
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const page = { id: 7, createdById: "user-1", ownerUserId: "user-1", contentText: "x" };

function makeDb() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    from: self,
    leftJoin: self,
    innerJoin: self,
    where: self,
    groupBy: self,
    orderBy: self,
    limit: jest.fn().mockResolvedValue([]),
    then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue(page) },
      kbPageComments: { findMany: jest.fn().mockResolvedValue([]) },
    },
  });
  return chain;
}

describe("every KB surface builds its predicate from resolved project access", () => {
  beforeEach(() => {
    pageVisibleTo.mockClear();
  });

  const surfaces: Array<{ name: string; run: () => Promise<unknown> }> = [
    {
      name: "analytics",
      run: () => new KbAnalyticsService(makeDb() as never).pages(USER),
    },
    {
      name: "page AI",
      run: () =>
        new KbPageAiService(makeDb() as never, {} as never, {} as never).summarize(USER, 7),
    },
    {
      name: "comments",
      run: () => new KbPageCommentsService(makeDb() as never, {} as never, {} as never).list(USER, 7),
    },
    {
      name: "record links",
      run: () => new KbPageRecordLinksService(makeDb() as never).list(USER, 7),
    },
  ];

  for (const surface of surfaces) {
    it(`${surface.name} passes the caller's accessible projects, never a blank list`, async () => {
      await surface.run().catch(() => undefined);

      expect(pageVisibleTo).toHaveBeenCalled();
      for (const call of pageVisibleTo.mock.calls) {
        expect(call[0]).toBe(USER);
        expect(call[1]).toEqual(ACCESSIBLE);
      }
    });
  }
});
