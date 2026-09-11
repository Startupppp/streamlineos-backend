import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { assertPageAccessible } from "../kb/retrieval/kb-page-access.util";
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

// A db double that records the predicate it was asked for and returns whatever the test says the database would
function captureDb(row: unknown) {
  const captured: { where?: SQL } = {};
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where", "limit", "orderBy", "groupBy"])
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
  };
  return { db: db as unknown as Db, captured };
}

// c25-02's matrix, as an executed spec rather than a controller e2e file: *.e2e-spec.ts is in testPathIgnorePatterns, so a matrix written there would produce four ticks and zero running assertions
describe("the record-access seam composes every arm in one predicate", () => {
  it("puts tenant, soft-delete, identity and the audience ACL in a single query", async () => {
    const { db, captured } = captureDb({ id: 7 });
    await assertPageAccessible(db, actor(), 7);

    const sql = render(captured.where as SQL);
    expect(sql).toContain("org_id");
    expect(sql).toContain("deleted_at");
    expect(sql).toContain("id");
    expect(sql).toContain("visibility");
  });

  it("returns not-found, never forbidden, when the predicate matches nothing", async () => {
    const { db } = captureDb(undefined);
    await expect(assertPageAccessible(db, actor(), 7)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("asks for the caller's own tenant, so another org's id cannot match", async () => {
    const { db, captured } = captureDb({ id: 7 });
    await assertPageAccessible(db, actor({ orgId: "org-B" }), 7);
    expect(dialect.sqlToQuery(captured.where as SQL).params).toContain("org-B");
  });
});

describe("the audience ACL is SQL, not an application-code check", () => {
  it("narrows a member to org-wide, public and their own pages", () => {
    const sql = render(pageVisibleTo(actor(), []));
    expect(sql).toContain("visibility");
    expect(sql).toContain("created_by");
  });

  it("widens to the projects the caller can reach, still in the predicate", () => {
    const sql = render(pageVisibleTo(actor(), [11, 12]));
    expect(sql).toContain("project_id");
    expect(sql).toContain("ANY");
  });

  it("does not narrow an org owner", () => {
    const sql = render(pageVisibleTo(actor({ isOrgOwner: true }), []));
    expect(sql).not.toContain("visibility");
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
