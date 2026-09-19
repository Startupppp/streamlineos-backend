import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { ManagedProductsService } from "./managed-products/managed-products.service";
import { TeamsService } from "./teams/teams.service";
import { PmWorkspacesService } from "./pm-workspaces/pm-workspaces.service";

const dialect = new PgDialect();

function renderParams(condition: unknown): unknown[] {
  return dialect.sqlToQuery(condition as SQL).params;
}

const audit = { log: jest.fn() } as never;
const ORG = "org-1";

function makeListDb() {
  const limit = jest.fn().mockResolvedValue([]);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

describe("Build scope filters reach the WHERE clause", () => {
  it("filters managed products by pmWorkspaceId", async () => {
    const { db, where } = makeListDb();
    await new ManagedProductsService(db, audit, {} as never).listManagedProducts(
      ORG,
      { limit: 20, pmWorkspaceId: "ws-7" } as never,
    );
    expect(renderParams(where.mock.calls[0]?.[0])).toContain("ws-7");
  });

  it("filters managed products by search term", async () => {
    const { db, where } = makeListDb();
    await new ManagedProductsService(db, audit, {} as never).listManagedProducts(
      ORG,
      { limit: 20, search: "atlas" } as never,
    );
    expect(renderParams(where.mock.calls[0]?.[0])).toContain("%atlas%");
  });

  it("filters teams by pmWorkspaceId", async () => {
    const { db, where } = makeListDb();
    await new TeamsService(db, audit, {} as never).listTeams(ORG, {
      pageSize: 50,
      pmWorkspaceId: "ws-7",
    } as never);
    expect(renderParams(where.mock.calls[0]?.[0])).toContain("ws-7");
  });

  it("filters workspaces by search term", async () => {
    const { db, where } = makeListDb();
    await new PmWorkspacesService(db, audit).listWorkspaces(ORG, {
      limit: 20,
      search: "delivery",
    } as never);
    expect(renderParams(where.mock.calls[0]?.[0])).toContain("%delivery%");
  });

  it("keeps every scoped list bound to the caller's organization", async () => {
    const { db, where } = makeListDb();
    await new ManagedProductsService(db, audit, {} as never).listManagedProducts(
      ORG,
      { limit: 20, pmWorkspaceId: "ws-7" } as never,
    );
    expect(renderParams(where.mock.calls[0]?.[0])).toContain(ORG);
  });

  it("does not constrain by workspace when no workspace is requested", async () => {
    const { db, where } = makeListDb();
    await new ManagedProductsService(db, audit, {} as never).listManagedProducts(
      ORG,
      { limit: 20 } as never,
    );
    expect(renderParams(where.mock.calls[0]?.[0])).not.toContain("ws-7");
  });
});
