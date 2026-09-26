import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ACCESSIBLE = [42];

jest.mock("./kb-project-access.util", () => ({
  getAccessibleProjectIds: jest.fn().mockResolvedValue(ACCESSIBLE),
}));

const mockVisibleTo = jest.fn();
jest.mock("./kb-page-visibility", () => {
  const actual = jest.requireActual<typeof import("./kb-page-visibility")>(
    "./kb-page-visibility",
  );
  return {
    ...actual,
    visibleTo: (...args: Parameters<typeof actual.visibleTo>) => {
      mockVisibleTo(...args);
      return actual.visibleTo(...args);
    },
  };
});

const mockBuildVisiblePageScope = jest.fn();
jest.mock("../core/authorization/knowledge-page-scope", () => {
  const actual = jest.requireActual<
    typeof import("../core/authorization/knowledge-page-scope")
  >("../core/authorization/knowledge-page-scope");
  return {
    ...actual,
    buildVisiblePageScope: (...args: Parameters<typeof actual.buildVisiblePageScope>) => {
      mockBuildVisiblePageScope(...args);
      return actual.buildVisiblePageScope(...args);
    },
  };
});

import { buildVisiblePageScope } from "../core/authorization/knowledge-page-scope";
import type { KbActorStanding } from "../core/authorization/knowledge-authorization.types";
import { visibleTo } from "./kb-page-visibility";
import { kbPages } from "../../../db/schema";
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

const STANDING: KbActorStanding = {
  orgId: "org-1",
  userId: "user-1",
  membershipId: 1,
  roleSlugs: [],
  isOrgOwner: false,
  isKbAdmin: false,
  accessibleSpaceIds: [],
  accessibleProjectIds: ACCESSIBLE,
  permissionsVersion: 1,
};

describe("every KB surface takes its predicate from the canonical authorization seam", () => {
  beforeEach(() => {
    mockVisibleTo.mockClear();
    mockBuildVisiblePageScope.mockClear();
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

    it(`${surface.name} never rebuilds the page scope itself, bypassing the seam's standing resolution and cache`, async () => {
      const auth = makeAuth();

      await surface.run(auth).catch(() => undefined);

      expect(mockBuildVisiblePageScope).not.toHaveBeenCalled();
      expect(mockVisibleTo).not.toHaveBeenCalled();
    });
  }

  it("BITE: the negative fires the moment a caller builds the canonical page scope for itself", () => {
    buildVisiblePageScope(STANDING, "view");

    expect(mockBuildVisiblePageScope).toHaveBeenCalledTimes(1);
    expect(mockBuildVisiblePageScope).toHaveBeenCalledWith(STANDING, "view");
  });

  it("BITE: the negative also fires when a caller reaches for the legacy column-level predicate builder", () => {
    visibleTo(
      {
        orgId: kbPages.orgId,
        visibility: kbPages.visibility,
        projectId: kbPages.projectId,
        createdById: kbPages.createdById,
      },
      USER,
      ACCESSIBLE,
    );

    expect(mockVisibleTo).toHaveBeenCalledTimes(1);
  });
});
