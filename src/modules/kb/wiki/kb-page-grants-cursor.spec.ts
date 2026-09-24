import { decodeCursor } from "../../../common/pagination/cursor";
import { KbPageGrantsService } from "./kb-page-grants.service";
import type { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { PgDialect } from "drizzle-orm/pg-core";
import { kbPageGrants } from "../../../db/schema";
import { keysetBeforeMicros } from "../../../common/pagination/keyset";
import type { KbPageGrantsListQuery } from "./dto/kb-page-grants.schemas";

const ORG = "org-grants-cursor";
const PAGE_ID = 42;
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

function grantRow(id: number, micros: string) {
  return {
    id,
    pageId: PAGE_ID,
    membershipId: id,
    role: null,
    access: "view",
    grantedByMembershipId: 1,
    createdAt: new Date(`${micros.slice(0, 23)}Z`),
    revokedAt: null,
    createdAtMicros: micros,
  };
}

function makeService(grantRows: unknown[]) {
  const selectProjections: unknown[] = [];
  const chain = (rows: unknown[]): object =>
    Object.assign(Promise.resolve(rows), {
      limit: jest.fn(() => chain(rows)),
      orderBy: jest.fn(() => chain(rows)),
    });

  const db = {
    select: jest.fn().mockImplementation((projection: unknown) => {
      selectProjections.push(projection);
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn(() => chain(grantRows)),
        }),
      };
    }),
  } as unknown as Db;

  const auth = {
    assertPageAccess: jest.fn().mockResolvedValue(undefined),
  } as unknown as KnowledgeAuthorizationService;

  const audit = {} as unknown as AuditService;

  return { svc: new KbPageGrantsService(db, auth, audit), selectProjections };
}

describe("KbPageGrantsService.list — cursor precision", () => {
  const query = { limit: LIMIT } as KbPageGrantsListQuery;

  it("carries full microsecond precision in nextCursor, so a row inside the sub-millisecond gap is not skipped", async () => {
    const rows = [
      grantRow(3, "2026-03-01T10:00:00.500900"),
      grantRow(2, "2026-03-01T10:00:00.500400"),
      grantRow(1, "2026-03-01T10:00:00.500100"),
    ];
    const { svc } = makeService(rows);

    const page = await svc.list(makeUser(), PAGE_ID, query);

    expect(page.pagination.hasMore).toBe(true);
    const position = decodeCursor(page.pagination.nextCursor);
    expect(position).not.toBeNull();
    expect(position?.sortValue).toBe("2026-03-01T10:00:00.500400");
  });

  it("does not truncate the boundary to milliseconds, which would skip every row in the same millisecond", async () => {
    const rows = [
      grantRow(3, "2026-03-01T10:00:00.500900"),
      grantRow(2, "2026-03-01T10:00:00.500400"),
      grantRow(1, "2026-03-01T10:00:00.500100"),
    ];
    const { svc } = makeService(rows);

    const page = await svc.list(makeUser(), PAGE_ID, query);
    const position = decodeCursor(page.pagination.nextCursor);

    expect(position?.sortValue).not.toBe("2026-03-01T10:00:00.500Z");
    expect(position?.sortValue).not.toBe("2026-03-01T10:00:00.500000");
  });

  it("projects the boundary column at microsecond precision rather than relying on the driver Date", async () => {
    const rows = [grantRow(1, "2026-03-01T10:00:00.500100")];
    const { svc, selectProjections } = makeService(rows);

    await svc.list(makeUser(), PAGE_ID, query);

    const projection = selectProjections[0] as Record<string, unknown>;
    expect(projection).toHaveProperty("createdAtMicros");
  });

  it("omits the internal cursor column from the returned rows, so it never becomes part of the response contract", async () => {
    const rows = [grantRow(1, "2026-03-01T10:00:00.500100")];
    const { svc } = makeService(rows);

    const page = await svc.list(makeUser(), PAGE_ID, query);

    expect(page.data).toHaveLength(1);
    expect(page.data[0]).not.toHaveProperty("createdAtMicros");
    expect(page.data[0]).toHaveProperty("access", "view");
  });

  it("builds a '<' predicate matching DESC sort order, so pagination moves toward older rows", () => {
    const clause = keysetBeforeMicros(kbPageGrants.createdAt, kbPageGrants.id, {
      sortValue: "2026-03-01T10:00:00.500400",
      id: 5,
    });
    const { sql: rendered } = new PgDialect().sqlToQuery(clause);
    expect(rendered).toContain("<");
    expect(rendered).not.toContain(">");
  });
});
