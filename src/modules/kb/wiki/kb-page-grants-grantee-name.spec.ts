import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";
import { KbPageGrantsService } from "./kb-page-grants.service";
import type { KbPageGrantsListQuery } from "./dto/kb-page-grants.schemas";
import { users } from "../../../db/schema";

const ORG = "org-grantee";
const PAGE_ID = 77;

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  } as never;
}

function grantRowWithUser(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 5,
    pageId: PAGE_ID,
    membershipId: 101,
    role: null,
    access: "view",
    grantedByMembershipId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    revokedAt: null,
    createdAtMicros: "2026-06-01T00:00:00.000000",
    granteeName: "Alice Smith",
    granteeEmail: "alice@example.com",
    granteeImage: null,
    ...overrides,
  };
}

function roleGrantRow(): Record<string, unknown> {
  return {
    id: 6,
    pageId: PAGE_ID,
    membershipId: null,
    role: "engineer",
    access: "view",
    grantedByMembershipId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    revokedAt: null,
    createdAtMicros: "2026-06-01T00:00:00.000000",
    granteeName: null,
    granteeEmail: null,
    granteeImage: null,
  };
}

interface SelectCapture {
  projections: Record<string, unknown>[];
  leftJoinConditions: SQL[];
  limitArgs: number[];
}

function makeListService(grantRows: unknown[]): { svc: KbPageGrantsService; capture: SelectCapture } {
  const capture: SelectCapture = { projections: [], leftJoinConditions: [], limitArgs: [] };

  const chain = (rows: unknown[]): object =>
    Object.assign(Promise.resolve(rows), {
      orderBy: jest.fn(() => chain(rows)),
      limit: jest.fn((n: number) => {
        capture.limitArgs.push(n);
        return chain(rows);
      }),
    });

  const db = {
    select: jest.fn().mockImplementation((projection: Record<string, unknown>) => {
      capture.projections.push(projection);
      const fromResult: { leftJoin: jest.Mock; where: jest.Mock } = {
        leftJoin: jest.fn((_table: unknown, cond: SQL) => {
          capture.leftJoinConditions.push(cond);
          return fromResult;
        }),
        where: jest.fn(() => chain(grantRows)),
      };
      return { from: jest.fn().mockReturnValue(fromResult) };
    }),
  } as unknown as Db;

  const auth = {
    assertPageAccess: jest.fn().mockResolvedValue(undefined),
  } as unknown as KnowledgeAuthorizationService;

  const audit = {} as unknown as AuditService;

  return { svc: new KbPageGrantsService(db, auth, audit), capture };
}

const dialect = new PgDialect();

describe("KbPageGrantsService.list — grantee name projection via leftJoin", () => {
  const query: KbPageGrantsListQuery = { limit: 10 };

  it("the list projection uses users.name as a column reference, not a per-row subquery, so a single join pass resolves names for every row", async () => {
    const { svc, capture } = makeListService([]);
    await svc.list(makeUser(), PAGE_ID, query);

    const projection = capture.projections[0] as Record<string, unknown>;
    expect(projection).toHaveProperty("granteeName");
    expect(projection["granteeName"]).toBe(users.name);
    expect(projection["granteeEmail"]).toBe(users.email);
    expect(projection["granteeImage"]).toBe(users.image);
  });

  it("the leftJoin to organizationMembers uses both org_id and membership_id as join keys, matching the unique constraint on (org_id, id) so no grant row is multiplied by the join", async () => {
    const { svc, capture } = makeListService([]);
    await svc.list(makeUser(), PAGE_ID, query);

    expect(capture.leftJoinConditions.length).toBeGreaterThanOrEqual(1);
    const orgMemberJoinCond = capture.leftJoinConditions[0]!;
    const q = dialect.sqlToQuery(orgMemberJoinCond);
    expect(q.sql).toContain("org_id");
    expect(q.sql).toContain("membership_id");
  });

  it("the outer list query is bounded by query.limit + 1 to detect the next page", async () => {
    const LIMIT = 7;
    const { svc, capture } = makeListService([]);
    await svc.list(makeUser(), PAGE_ID, { limit: LIMIT });
    expect(capture.limitArgs[0]).toBe(LIMIT + 1);
  });

  it("a user grant row (positive control) carries granteeName and granteeEmail resolved by the server join", async () => {
    const { svc } = makeListService([grantRowWithUser()]);
    const page = await svc.list(makeUser(), PAGE_ID, query);

    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      granteeName: "Alice Smith",
      granteeEmail: "alice@example.com",
      granteeImage: null,
      membershipId: 101,
    });
  });

  it("a role grant has null grantee display fields and a non-null role so the UI can use role as the display label", async () => {
    const { svc } = makeListService([roleGrantRow()]);
    const page = await svc.list(makeUser(), PAGE_ID, query);

    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      role: "engineer",
      membershipId: null,
      granteeName: null,
      granteeEmail: null,
      granteeImage: null,
    });
  });
});
