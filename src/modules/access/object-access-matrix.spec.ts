import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { KnowledgeAuthorizationService } from "../kb/core/authorization/knowledge-authorization.service";
import { pageVisibleTo } from "../kb/retrieval/kb-page-visibility";
import { ScopedRead, type ScopedWhere } from "./scoped-read";
import { organizationMembers } from "../../db/schema";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();
const render = (predicate: SQL) => dialect.sqlToQuery(predicate).sql;

const actor = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "u-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
  ...overrides,
});

function captureDb(row: unknown) {
  const captured: { where?: SQL } = {};
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where", "limit", "orderBy", "groupBy", "selectDistinct"])
    chain[method] = () => chain;
  Object.assign(chain, { then: (resolve: (rows: unknown[]) => void) => resolve([]) });

  const db = {
    query: {
      kbPages: {
        findFirst: (args: { where: SQL }) => {
          captured.where = args.where;
          return Promise.resolve(row);
        },
      },
    },
    select: () => chain,
    selectDistinct: () => chain,
  };
  return { db: db as unknown as Db, captured };
}

function buildAuth(db: Db): KnowledgeAuthorizationService {
  const cache = {
    cachedVersioned: jest.fn().mockImplementation(
      (_ns: unknown, _key: unknown, fill: () => Promise<unknown>) => fill(),
    ),
  };
  const access = {
    holds: jest.fn().mockResolvedValue(false),
    getPermissionsVersion: jest.fn().mockResolvedValue(1),
  };
  return new KnowledgeAuthorizationService(db, cache as never, access as never);
}

describe("the record-access seam composes every arm in one predicate", () => {
  it("puts tenant, soft-delete, identity and the audience ACL in a single query", async () => {
    const { db, captured } = captureDb({ id: 7 });
    const auth = buildAuth(db);
    await auth.assertPageAccess(actor(), 7, "view");

    const sqlStr = render(captured.where as SQL);
    expect(sqlStr).toContain("org_id");
    expect(sqlStr).toContain("deleted_at");
    expect(sqlStr).toContain("id");
    expect(sqlStr).toContain("visibility");
  });

  it("returns not-found, never forbidden, when the predicate matches nothing", async () => {
    const { db } = captureDb(undefined);
    const auth = buildAuth(db);
    await expect(auth.assertPageAccess(actor(), 7, "view")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("asks for the caller's own tenant, so another org's id cannot match", async () => {
    const { db, captured } = captureDb({ id: 7, ownerMembershipId: null, createdById: null, createdByMembershipId: null, visibility: "org", spaceId: null, projectId: null });
    const auth = buildAuth(db);
    await auth.assertPageAccess(actor({ orgId: "org-B" }), 7, "view");
    expect(dialect.sqlToQuery(captured.where as SQL).params).toContain("org-B");
  });
});

describe("the audience ACL is SQL, not an application-code check", () => {
  it("narrows a member to org-wide, public and their own pages", () => {
    const sqlStr = render(pageVisibleTo(actor(), []));
    expect(sqlStr).toContain("visibility");
    expect(sqlStr).toContain("created_by");
  });

  it("widens to the projects the caller can reach, still in the predicate", () => {
    const sqlStr = render(pageVisibleTo(actor(), [11, 12]));
    expect(sqlStr).toContain("project_id");
    expect(sqlStr).toContain("ANY");
  });

  it("does not narrow an org owner", () => {
    const sqlStr = render(pageVisibleTo(actor({ isOrgOwner: true }), []));
    expect(sqlStr).not.toContain("visibility");
  });
});

describe("the DataScope arm denies before it widens", () => {
  const SPEC = {
    tenant: organizationMembers.orgId,
    scope: { columns: { ownerColumn: organizationMembers.userId } },
  };
  const clause = (scope: "all" | "own" | "none"): ScopedWhere | null =>
    ScopedRead.of("org-1", "u-1", scope).compose(SPEC, (where) => where, () => null);

  it("builds no clause at all for none, so an unheld key never queries", () => {
    expect(clause("none")).toBeNull();
  });

  it("renders own as an owner-column equality beside the tenant predicate", () => {
    const rendered = render((clause("own") as ScopedWhere).sql);
    expect(rendered).toContain("user_id");
    expect(rendered).toContain("org_id");
  });

  it("renders all without the owner equality, and own with it", () => {
    expect(render((clause("all") as ScopedWhere).sql)).not.toContain("user_id");
    expect(render((clause("own") as ScopedWhere).sql)).toContain("user_id");
  });
});
