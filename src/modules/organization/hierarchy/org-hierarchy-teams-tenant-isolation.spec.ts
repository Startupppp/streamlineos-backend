import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { OrgHierarchyTeamsService } from "./org-hierarchy-teams.service";
import type { Db } from "../../../db/drizzle.module";
import { OrgUnitCrudService } from "./org-unit-crud";
import { orgHierarchyCacheStub } from "../../../../test/helpers/org-hierarchy-cache-stub";

const dialect = new PgDialect();

function render(value: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]);
  return { sql: query.sql, params: query.params };
}

interface Captured {
  selectWheres: unknown[];
  updateWheres: unknown[];
}

function makeSelectChain(rows: unknown[], captured: Captured) {
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where: jest.fn((cond: unknown) => {
      captured.selectWheres.push(cond);
      return builder;
    }),
    limit: jest.fn(),
    orderBy: jest.fn(),
    leftJoin: jest.fn(),
    then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) {
      return Promise.resolve(rows).then(fn, r);
    },
    catch(fn: (e: unknown) => unknown) {
      return Promise.resolve(rows).catch(fn);
    },
    finally(fn: () => void) {
      return Promise.resolve(rows).finally(fn);
    },
  };
  for (const k of ["from", "limit", "orderBy", "leftJoin"]) {
    (builder[k] as jest.Mock).mockReturnValue(builder);
  }
  return builder;
}

describe("OrgHierarchyTeamsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const TEAM_ID = "t1";
  const TEAM = {
    id: TEAM_ID,
    orgId: OWNER,
    name: "Backend Team",
    code: null,
    description: null,
    status: "ACTIVE",
    parentId: null,
    metadata: null,
    headUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  function makeService(rows: unknown[]) {
    const captured: Captured = { selectWheres: [], updateWheres: [] };
    const updateBuilder: Record<string, unknown> = {
      set: jest.fn(),
      where: jest.fn((cond: unknown) => {
        captured.updateWheres.push(cond);
        return updateBuilder;
      }),
      returning: jest.fn().mockResolvedValue(rows),
      then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) {
        return Promise.resolve(undefined).then(fn, r);
      },
    };
    (updateBuilder.set as jest.Mock).mockReturnValue(updateBuilder);

    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain(rows, captured)),
      update: jest.fn().mockReturnValue(updateBuilder),
    } as unknown as Db;
    const audit = { log: jest.fn(), logCritical: jest.fn() };
    const cache = orgHierarchyCacheStub();
    const svc = new OrgHierarchyTeamsService(
      new OrgUnitCrudService(db, audit, cache),
    );
    return { svc, captured };
  }

  describe("listTeams", () => {
    it("constrains the query to the caller org and excludes soft-deleted rows", async () => {
      const { svc, captured } = makeService([]);

      const result = await svc.listTeams(ATTACKER, { limit: 20 });

      expect(result.data).toHaveLength(0);
      const { sql, params } = render(captured.selectWheres[0]);
      expect(sql).toContain('"org_units"."org_id" = $');
      expect(sql).toContain('"org_units"."kind" = $');
      expect(sql).toContain('"org_units"."deleted_at" is null');
      expect(params).toContain(ATTACKER);
      expect(params).toContain("TEAM");
      expect(params).not.toContain(OWNER);
    });

    it("returns rows for the owning org (control)", async () => {
      const { svc } = makeService([TEAM]);

      const result = await svc.listTeams(OWNER, { limit: 20 });

      expect(result.data.length).toBeGreaterThan(0);
    });
  });

  describe("getTeam", () => {
    it("binds both the team id and the caller org, so a foreign id resolves to null", async () => {
      const { svc, captured } = makeService([]);

      await expect(svc.getTeam(ATTACKER, TEAM_ID)).resolves.toBeNull();

      const { sql, params } = render(captured.selectWheres[0]);
      expect(sql).toContain('"org_units"."id" = $');
      expect(sql).toContain('"org_units"."org_id" = $');
      expect(sql).toContain('"org_units"."deleted_at" is null');
      expect(params).toEqual(expect.arrayContaining([TEAM_ID, ATTACKER]));
      expect(params).not.toContain(OWNER);
    });
  });

  describe("updateTeam", () => {
    it("refuses a foreign team id with NotFound, never Forbidden, and writes nothing", async () => {
      const { svc, captured } = makeService([]);

      await expect(
        svc.updateTeam(ATTACKER, "user-1", TEAM_ID, { name: "Renamed" }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(captured.updateWheres).toHaveLength(0);
    });

    it("scopes the update itself to the caller org, not only the pre-read", async () => {
      const { svc, captured } = makeService([TEAM]);

      await svc.updateTeam(OWNER, "user-1", TEAM_ID, { name: "Renamed" });

      const { sql, params } = render(captured.updateWheres[0]);
      expect(sql).toContain('"org_units"."org_id" = $');
      expect(params).toEqual(expect.arrayContaining([TEAM_ID, OWNER]));
    });
  });

  // Ported from the deleted hard-delete route: the archive write now carries its cross-tenant assertion.
  describe("archive via updateTeam", () => {
    it("refuses a foreign team id with NotFound and writes nothing", async () => {
      const { svc, captured } = makeService([]);

      await expect(
        svc.updateTeam(ATTACKER, "user-1", TEAM_ID, { status: "ARCHIVED" }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(captured.updateWheres).toHaveLength(0);
    });

    it("scopes the archive write to the caller org", async () => {
      const { svc, captured } = makeService([TEAM]);

      await svc.updateTeam(OWNER, "user-1", TEAM_ID, { status: "ARCHIVED" });

      const { sql, params } = render(captured.updateWheres[0]);
      expect(sql).toContain('"org_units"."org_id" = $');
      expect(params).toEqual(expect.arrayContaining([TEAM_ID, OWNER]));
    });
  });
});
