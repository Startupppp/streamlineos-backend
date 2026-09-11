import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { OrgHierarchyDepartmentsService } from "./org-hierarchy-departments.service";
import type { Db } from "../../../db/drizzle.module";
import { OrgUnitCrudService } from "./org-unit-crud";

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

describe("OrgHierarchyDepartmentsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const DEPT_ID = "d1";
  const DEPT = {
    id: DEPT_ID,
    orgId: OWNER,
    name: "Engineering",
    kind: "DEPARTMENT",
    status: "ACTIVE",
    parentId: null,
    headUserId: null,
    code: "ENG",
    description: null,
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
      query: { orgUnits: { findFirst: jest.fn().mockResolvedValue(undefined) } },
    } as unknown as Db;
    const audit = { log: jest.fn(), logCritical: jest.fn() };
    const cache = { invalidateAfterMutation: jest.fn() };
    const svc = new OrgHierarchyDepartmentsService(
      new OrgUnitCrudService(db, audit, cache),
    );
    return { svc, captured };
  }

  describe("listDepartments", () => {
    it("constrains the query to the caller org and excludes soft-deleted rows", async () => {
      const { svc, captured } = makeService([]);

      const result = await svc.listDepartments(ATTACKER, { limit: 20 });

      expect(result.data).toHaveLength(0);
      const { sql, params } = render(captured.selectWheres[0]);
      expect(sql).toContain('"org_units"."org_id" = $');
      expect(sql).toContain('"org_units"."deleted_at" is null');
      expect(params).toContain(ATTACKER);
      expect(params).not.toContain(OWNER);
    });

    it("returns rows for the owning org (control)", async () => {
      const { svc } = makeService([DEPT]);

      const result = await svc.listDepartments(OWNER, { limit: 20 });

      expect(result.data.length).toBeGreaterThan(0);
    });
  });

  describe("getDepartment", () => {
    it("binds both the department id and the caller org, so a foreign id resolves to null", async () => {
      const { svc, captured } = makeService([]);

      await expect(svc.getDepartment(ATTACKER, DEPT_ID)).resolves.toBeNull();

      const { sql, params } = render(captured.selectWheres[0]);
      expect(sql).toContain('"org_units"."id" = $');
      expect(sql).toContain('"org_units"."org_id" = $');
      expect(sql).toContain('"org_units"."deleted_at" is null');
      expect(params).toEqual(expect.arrayContaining([DEPT_ID, ATTACKER]));
      expect(params).not.toContain(OWNER);
    });
  });

  describe("updateDepartment", () => {
    it("refuses a foreign department id with NotFound, never Forbidden, and writes nothing", async () => {
      const { svc, captured } = makeService([]);

      await expect(
        svc.updateDepartment(ATTACKER, "user-1", DEPT_ID, { name: "Renamed" }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(captured.updateWheres).toHaveLength(0);
    });

    it("scopes the update itself to the caller org, not only the pre-read", async () => {
      const { svc, captured } = makeService([DEPT]);

      await svc.updateDepartment(OWNER, "user-1", DEPT_ID, { name: "Renamed" });

      const { sql, params } = render(captured.updateWheres[0]);
      expect(sql).toContain('"org_units"."org_id" = $');
      expect(params).toEqual(expect.arrayContaining([DEPT_ID, OWNER]));
    });
  });

  // Ported from the deleted hard-delete route: the archive write now carries its cross-tenant assertion.
  describe("archive via updateDepartment", () => {
    it("refuses a foreign department id with NotFound and writes nothing", async () => {
      const { svc, captured } = makeService([]);

      await expect(
        svc.updateDepartment(ATTACKER, "user-1", DEPT_ID, { status: "ARCHIVED" }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(captured.updateWheres).toHaveLength(0);
    });

    it("scopes the archive write to the caller org", async () => {
      const { svc, captured } = makeService([DEPT]);

      await svc.updateDepartment(OWNER, "user-1", DEPT_ID, { status: "ARCHIVED" });

      const { sql, params } = render(captured.updateWheres[0]);
      expect(sql).toContain('"org_units"."org_id" = $');
      expect(params).toEqual(expect.arrayContaining([DEPT_ID, OWNER]));
    });
  });
});
