import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ACCESSIBLE = [42];

jest.mock("./kb-project-access.util", () => ({
  getAccessibleProjectIds: jest.fn().mockResolvedValue(ACCESSIBLE),
}));
jest.mock("./kb-project-access.util", () => ({
  getAccessibleProjectIds: jest.fn().mockResolvedValue(ACCESSIBLE),
}));

const pageVisibleTo = jest.fn().mockReturnValue({ marker: "predicate" });
jest.mock("./kb-page-visibility", () => ({
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
    having: self,
    orderBy: self,
    limit: jest.fn().mockResolvedValue([]),
    then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue(page) },
      kbPageComments: { findMany: jest.fn().mockResolvedValue([]) },
    },
    // `KbPageAiService.summarize` reads through `loadPage`, whose short tenant
    // transaction commits before the provider call. `withTenant` opens it and
    // probes the placement fence, so the double needs both seams — otherwise the
    // surface below throws before `pageVisibleTo` is ever reached and the
    // `.catch()` in the test swallows it.
    execute: jest.fn().mockResolvedValue([{ placement_fence_held: 1 }]),
    transaction: <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(chain),
  });
  return chain;
}

function makeAuth(): { visiblePagePredicate: jest.Mock; assertPageAccess: jest.Mock } {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue({ marker: "canonical-scope" }),
    assertPageAccess: jest
      .fn()
      .mockResolvedValue({ orgId: "org-1", pageId: 7, action: "view", via: "admin" }),
  };
}

describe("every KB surface takes its predicate from the canonical authorization seam", () => {
  beforeEach(() => {
    pageVisibleTo.mockClear();
  });

  const surfaces: Array<{
    name: string;
    run: (auth: ReturnType<typeof makeAuth>) => Promise<unknown>;
  }> = [
    {
      name: "analytics",
      run: (auth) => new KbAnalyticsService(makeDb() as never, auth as never).pages(USER),
    },
    {
      name: "page AI",
      run: (auth) =>
        new KbPageAiService(
          makeDb() as never,
          {} as never,
          {} as never,
          auth as never,
        ).summarize(USER, 7),
    },
    {
      name: "comments",
      run: (auth) =>
        new KbPageCommentsService(
          makeDb() as never,
          {} as never,
          {} as never,
          auth as never,
        ).list(USER, 7),
    },
    {
      name: "record links",
      run: (auth) =>
        new KbPageRecordLinksService(makeDb() as never, auth as never).list(USER, 7),
    },
  ];

  for (const surface of surfaces) {
    it(`${surface.name} asks the canonical seam for the acting user's scope`, async () => {
      const auth = makeAuth();

      await surface.run(auth).catch(() => undefined);

      const consulted =
        auth.visiblePagePredicate.mock.calls.length + auth.assertPageAccess.mock.calls.length;
      expect(consulted).toBeGreaterThan(0);
      for (const call of auth.visiblePagePredicate.mock.calls) expect(call[0]).toBe(USER);
      for (const call of auth.assertPageAccess.mock.calls) expect(call[0]).toBe(USER);
    });

    it(`${surface.name} never rebuilds authorization through the retired visibility predicate`, async () => {
      const auth = makeAuth();

      await surface.run(auth).catch(() => undefined);

      expect(pageVisibleTo).not.toHaveBeenCalled();
    });
  }
});
