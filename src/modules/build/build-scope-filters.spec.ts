import { managedProductsService } from "./managed-products/__tests__/managed-products-spec-fixtures";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { ManagedProductsService } from "./managed-products/managed-products.service";
import { TeamsService } from "./teams/teams.service";

const dialect = new PgDialect();

function renderParams(condition: unknown): unknown[] {
  return dialect.sqlToQuery(condition as SQL).params;
}

const audit = { log: jest.fn() } as never;
const ORG = "org-1";
const MEMBER = 4101;

function makeListDb() {
  const limit = jest.fn().mockResolvedValue([]);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

describe("Build scope filters reach the WHERE clause", () => {
  it("filters managed products by a trailing-wildcard search term, so the predicate can use an org-led btree index under RLS where a trigram index is dead (BE-49, BE-80)", async () => {
    const { db, where } = makeListDb();
    await (await managedProductsService(db, audit)).listManagedProducts(
      ORG,
      { limit: 20, search: "atlas" } as never,
      MEMBER,
    );
    expect(renderParams(where.mock.calls[0]?.[0])).toContain("atlas%");
    expect(renderParams(where.mock.calls[0]?.[0])).not.toContain("%atlas");
  });

  it("filters teams by a trailing-wildcard search term, for the same reason managed products do (BE-49, BE-80)", async () => {
    const { db, where } = makeListDb();
    await new TeamsService(db, audit).listTeams(ORG, {
      pageSize: 50,
      search: "eng",
    } as never, MEMBER);
    expect(renderParams(where.mock.calls[0]?.[0])).toContain("eng%");
    expect(renderParams(where.mock.calls[0]?.[0])).not.toContain("%eng");
  });

  it("keeps every scoped list bound to the caller's organization", async () => {
    const { db, where } = makeListDb();
    await (await managedProductsService(db, audit)).listManagedProducts(
      ORG,
      { limit: 20, search: "atlas" } as never,
      MEMBER,
    );
    expect(renderParams(where.mock.calls[0]?.[0])).toContain(ORG);
  });

  it("keeps team lists bound to the caller's organization", async () => {
    const { db, where } = makeListDb();
    await new TeamsService(db, audit).listTeams(ORG, {
      pageSize: 50,
    } as never, MEMBER);
    expect(renderParams(where.mock.calls[0]?.[0])).toContain(ORG);
  });
});
