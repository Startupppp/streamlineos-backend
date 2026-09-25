import { sql } from "drizzle-orm";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { ScopedRead } from "../../access/scoped-read";
import type { Db } from "../../../db/drizzle.module";
import { KbSpacesService } from "./kb-spaces.service";
import type { KbAccessService } from "../core/kb-access.service";
import type { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import type { KbIndexingService } from "../retrieval/kb-indexing.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ListSpacesQuery } from "../core/dto/kb.schemas";

const ORG = "org-review-summary";
const SPACE_ID = 9;

function makeUser() {
  return { orgId: ORG, userId: "user-1", isOrgOwner: false } as never;
}

function makeCountChain(count: number): object {
  return Object.assign(Promise.resolve([{ count }]), {
    from: jest.fn().mockImplementation(function (this: object) {
      return this;
    }),
    where: jest.fn().mockImplementation(function (this: object) {
      return this;
    }),
  });
}

function makeGetService(counts: { overdue: number; withPolicy: number }): KbSpacesService {
  let call = 0;
  const values = [counts.overdue, counts.withPolicy];
  const db = {
    query: {
      kbSpaces: {
        findFirst: jest.fn().mockResolvedValue({ id: SPACE_ID, orgId: ORG, deletedAt: null }),
      },
    },
    select: jest.fn().mockImplementation(() => {
      const idx = call;
      call += 1;
      return makeCountChain(values[idx] ?? 0);
    }),
  } as unknown as Db;
  const access = {
    assertSpaceAccessible: jest.fn().mockResolvedValue(undefined),
  } as unknown as KbAccessService;
  const authz = {
    visiblePagePredicate: jest.fn().mockResolvedValue(undefined),
  } as unknown as KnowledgeAuthorizationService;
  return new KbSpacesService(db, access, {} as KbIndexingService, authz);
}

describe("KbSpacesService.get — review-policy summary", () => {
  it("BITE: reports how many of the space's pages are overdue for review and how many carry a review policy", async () => {
    const svc = makeGetService({ overdue: 4, withPolicy: 11 });

    const result = await svc.get(makeUser(), SPACE_ID);

    expect(result.pagesOverdueForReview).toBe(4);
    expect(result.pagesWithReviewPolicy).toBe(11);
  });

  it("positive control: reports zero when no pages carry a review policy", async () => {
    const svc = makeGetService({ overdue: 0, withPolicy: 0 });

    const result = await svc.get(makeUser(), SPACE_ID);

    expect(result.pagesOverdueForReview).toBe(0);
    expect(result.pagesWithReviewPolicy).toBe(0);
  });
});

function makeListUser(): CurrentUserContext {
  return {
    orgId: ORG,
    userId: "user-1",
    membershipId: 1,
    role: "MEMBER",
    isOwner: false,
    principal: humanSessionPrincipal(1, false),
  } as never;
}

function makeListChain(rows: unknown[]): object {
  return Object.assign(Promise.resolve(rows), {
    limit: jest.fn(() => makeListChain(rows)),
    orderBy: jest.fn(() => makeListChain(rows)),
    groupBy: jest.fn(() => makeListChain(rows)),
  });
}

function makeListService(spaceRows: unknown[], overdueRows: unknown[]): KbSpacesService {
  const joinable = (rows: unknown[]): Record<string, unknown> => {
    const self: Record<string, unknown> = { where: jest.fn(() => makeListChain(rows)) };
    self.leftJoin = jest.fn(() => self);
    return self;
  };

  let call = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      const idx = call;
      call += 1;
      if (idx === 0) return { from: jest.fn().mockReturnValue(joinable(spaceRows)) };
      if (idx === 4) return { from: jest.fn().mockReturnValue(joinable(overdueRows)) };
      return { from: jest.fn().mockReturnValue(joinable([])) };
    }),
  } as unknown as Db;

  const access = {
    getAccessibleSpaceIds: jest.fn().mockResolvedValue([SPACE_ID]),
  } as unknown as KbAccessService;
  const authz = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  } as unknown as KnowledgeAuthorizationService;
  return new KbSpacesService(db, access, {} as KbIndexingService, authz);
}

describe("KbSpacesService.list — owner name and review-policy health summary", () => {
  const query = { limit: 20 } as ListSpacesQuery;

  it("BITE: projects the creator's resolved user name and the overdue-review count per space", async () => {
    const spaceRow = {
      id: SPACE_ID,
      name: "Engineering",
      slug: "engineering",
      description: null,
      audience: "internal",
      icon: null,
      isPublicHelpCenter: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      archivedAt: null,
      updatedAtMicros: "2026-01-02T00:00:00.000000",
      ownerName: "Priya Shah",
    };
    const svc = makeListService([spaceRow], [{ spaceId: SPACE_ID, count: 3 }]);

    const page = await svc.list(
      makeListUser(),
      ScopedRead.of(ORG, "u-1", "all"),
      query,
    );

    expect(page.data[0]).toMatchObject({ ownerName: "Priya Shah", pagesOverdueForReview: 3 });
  });

  it("positive control: defaults to null owner name and zero overdue count when there is no creator or overdue page", async () => {
    const spaceRow = {
      id: SPACE_ID,
      name: "Engineering",
      slug: "engineering",
      description: null,
      audience: "internal",
      icon: null,
      isPublicHelpCenter: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      archivedAt: null,
      updatedAtMicros: "2026-01-02T00:00:00.000000",
      ownerName: null,
    };
    const svc = makeListService([spaceRow], []);

    const page = await svc.list(
      makeListUser(),
      ScopedRead.of(ORG, "u-1", "all"),
      query,
    );

    expect(page.data[0]).toMatchObject({ ownerName: null, pagesOverdueForReview: 0 });
  });
});
