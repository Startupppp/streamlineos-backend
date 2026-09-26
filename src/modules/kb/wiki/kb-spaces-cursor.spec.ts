import { sql } from "drizzle-orm";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { ScopedRead } from "../../access/scoped-read";
import { decodeCursor } from "../../../common/pagination/cursor";
import type { Db } from "../../../db/drizzle.module";
import { KbSpacesService } from "./kb-spaces.service";
import type { KbAccessService } from "../core/kb-access.service";
import { KbIndexingService } from "../retrieval/kb-indexing.service";
import type { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ListSpacesQuery } from "../core/dto/kb.schemas";

const ORG = "org-cursor";
const LIMIT = 2;

function makeUser(): CurrentUserContext {
  return {
    orgId: ORG,
    userId: "user-1",
    membershipId: 1,
    role: "MEMBER",
    isOwner: false,
    principal: humanSessionPrincipal(1, false),
  } as never;
}

function spaceRow(id: number, micros: string) {
  return {
    id,
    name: `Space ${id}`,
    slug: `space-${id}`,
    description: null,
    audience: "internal",
    icon: null,
    isPublicHelpCenter: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date(`${micros.slice(0, 23)}Z`),
    archivedAt: null,
    updatedAtMicros: micros,
  };
}

function makeService(spaceRows: unknown[]) {
  const selectProjections: unknown[] = [];
  const chain = (rows: unknown[]): object =>
    Object.assign(Promise.resolve(rows), {
      limit: jest.fn(() => chain(rows)),
      orderBy: jest.fn(() => chain(rows)),
      groupBy: jest.fn(() => chain(rows)),
      offset: jest.fn(() => chain(rows)),
    });

  const joinableChain = (rows: unknown[]): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      where: jest.fn(() => chain(rows)),
    };
    self.leftJoin = jest.fn(() => self);
    return self;
  };

  let call = 0;
  const db = {
    select: jest.fn().mockImplementation((projection: unknown) => {
      selectProjections.push(projection);
      const rows = call === 0 ? spaceRows : [];
      call += 1;
      return {
        from: jest.fn().mockReturnValue(joinableChain(rows)),
      };
    }),
  } as unknown as Db;

  const access = {
    getAccessibleSpaceIds: jest.fn().mockResolvedValue([1, 2, 3]),
  } as unknown as KbAccessService;
  const indexing = new KbIndexingService(db, undefined as never, undefined as never);
  const authz = {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
   resolveStanding: jest.fn().mockResolvedValue({ accessibleSpaceIds: [], accessibleProjectIds: [], roleSlugs: [], membershipId: 1 }), invalidateSpaceScope: jest.fn().mockResolvedValue(undefined), assertSpaceAccess: jest.fn().mockResolvedValue(undefined), resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [], outcome: "hit" }) } as unknown as KnowledgeAuthorizationService;

  return { svc: new KbSpacesService(db, indexing, authz), selectProjections };
}

describe("KbSpacesService.list — cursor precision", () => {
  const query = { limit: LIMIT } as ListSpacesQuery;

  it("carries full microsecond precision in nextCursor, so a row inside the sub-millisecond gap is not skipped", async () => {
    const rows = [
      spaceRow(3, "2026-03-01T10:00:00.500900"),
      spaceRow(2, "2026-03-01T10:00:00.500400"),
      spaceRow(1, "2026-03-01T10:00:00.500100"),
    ];
    const { svc } = makeService(rows);

    const page = await svc.list(makeUser(), ScopedRead.of(ORG, "u-1", "all"), query);

    expect(page.pagination.hasMore).toBe(true);
    const position = decodeCursor(page.pagination.nextCursor);
    expect(position).not.toBeNull();
    expect(position?.sortValue).toBe("2026-03-01T10:00:00.500400");
  });

  it("does not truncate the boundary to milliseconds, which would re-serve or skip every row in the same millisecond", async () => {
    const rows = [
      spaceRow(3, "2026-03-01T10:00:00.500900"),
      spaceRow(2, "2026-03-01T10:00:00.500400"),
      spaceRow(1, "2026-03-01T10:00:00.500100"),
    ];
    const { svc } = makeService(rows);

    const page = await svc.list(makeUser(), ScopedRead.of(ORG, "u-1", "all"), query);
    const position = decodeCursor(page.pagination.nextCursor);

    expect(position?.sortValue).not.toBe("2026-03-01T10:00:00.500Z");
    expect(position?.sortValue).not.toBe("2026-03-01T10:00:00.500000");
  });

  it("projects the boundary column at microsecond precision rather than relying on the driver Date", async () => {
    const rows = [spaceRow(1, "2026-03-01T10:00:00.500100")];
    const { svc, selectProjections } = makeService(rows);

    await svc.list(makeUser(), ScopedRead.of(ORG, "u-1", "all"), query);

    const spaceProjection = selectProjections[0] as Record<string, unknown>;
    expect(spaceProjection).toHaveProperty("updatedAtMicros");
  });

  it("omits the internal cursor column from the returned rows, so it never becomes part of the response contract", async () => {
    const rows = [spaceRow(1, "2026-03-01T10:00:00.500100")];
    const { svc } = makeService(rows);

    const page = await svc.list(makeUser(), ScopedRead.of(ORG, "u-1", "all"), query);

    expect(page.data).toHaveLength(1);
    expect(page.data[0]).not.toHaveProperty("updatedAtMicros");
    expect(page.data[0]).toHaveProperty("name", "Space 1");
  });
});
