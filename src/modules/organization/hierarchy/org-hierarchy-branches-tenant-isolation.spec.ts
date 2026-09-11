import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { OrgHierarchyBranchesService } from "./org-hierarchy-branches.service";
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

describe("OrgHierarchyBranchesService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const BRANCH_ID = "b1";
  const BRANCH = {
    id: BRANCH_ID,
    orgId: OWNER,
    name: "HQ",
    kind: "BRANCH",
    status: "ACTIVE",
    parentId: null,
    headUserId: null,
    metadata: {},
    code: "HQ",
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
    const cache = orgHierarchyCacheStub();
    const svc = new OrgHierarchyBranchesService(
      new OrgUnitCrudService(db, audit, cache),
    );
    return { svc, captured };
  }

  describe("listOrgBranches", () => {
    it("constrains the query to the caller org and excludes soft-deleted rows", async () => {
      const { svc, captured } = makeService([]);

      const result = await svc.listOrgBranches(ATTACKER, { limit: 20 });

      expect(result.data).toHaveLength(0);
      const { sql, params } = render(captured.selectWheres[0]);
      expect(sql).toContain('"org_units"."org_id" = $');
      expect(sql).toContain('"org_units"."deleted_at" is null');
      expect(params).toContain(ATTACKER);
      expect(params).not.toContain(OWNER);
    });

    it("returns branches for the owning org (control)", async () => {
      const { svc } = makeService([BRANCH]);

      const result = await svc.listOrgBranches(OWNER, { limit: 20 });

      expect(result.data.length).toBeGreaterThan(0);
    });
  });

  describe("listOrgBranchOptions", () => {
    it("constrains the query to the caller org and excludes soft-deleted rows", async () => {
      const { svc, captured } = makeService([]);

      const result = await svc.listOrgBranchOptions(ATTACKER, { limit: 20 });

      expect(result.data).toHaveLength(0);
      const { sql, params } = render(captured.selectWheres[0]);
      expect(sql).toContain('"org_units"."org_id" = $');
      expect(sql).toContain('"org_units"."deleted_at" is null');
      expect(params).toContain(ATTACKER);
      expect(params).not.toContain(OWNER);
    });

    it("pins status to ACTIVE, so archived and disabled branches never reach a dropdown", async () => {
      const { svc, captured } = makeService([]);

      await svc.listOrgBranchOptions(OWNER, { limit: 20 });

      const { sql, params } = render(captured.selectWheres[0]);
      expect(sql).toContain('"org_units"."status" = $');
      expect(params).toContain("ACTIVE");
      expect(params).not.toContain("ARCHIVED");
      expect(params).not.toContain("DISABLED");
    });

    it("(negative control) the administrative list emits no status predicate without one", async () => {
      const { svc, captured } = makeService([]);

      await svc.listOrgBranches(OWNER, { limit: 20 });

      const { sql } = render(captured.selectWheres[0]);
      expect(sql).not.toContain('"org_units"."status" = $');
    });
  });

  describe("getOrgBranch", () => {
    it("binds both the branch id and the caller org, so a foreign id resolves to null", async () => {
      const { svc, captured } = makeService([]);

      await expect(svc.getOrgBranch(ATTACKER, BRANCH_ID)).resolves.toBeNull();

      const { sql, params } = render(captured.selectWheres[0]);
      expect(sql).toContain('"org_units"."id" = $');
      expect(sql).toContain('"org_units"."org_id" = $');
      expect(sql).toContain('"org_units"."deleted_at" is null');
      expect(params).toEqual(expect.arrayContaining([BRANCH_ID, ATTACKER]));
      expect(params).not.toContain(OWNER);
    });
  });

  describe("updateOrgBranch", () => {
    it("refuses a foreign branch id with NotFound, never Forbidden, and writes nothing", async () => {
      const { svc, captured } = makeService([]);

      await expect(
        svc.updateOrgBranch(ATTACKER, "user-1", BRANCH_ID, { name: "Renamed" }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(captured.updateWheres).toHaveLength(0);
    });

    it("scopes the update itself to the caller org, not only the pre-read", async () => {
      const { svc, captured } = makeService([BRANCH]);

      await svc.updateOrgBranch(OWNER, "user-1", BRANCH_ID, { name: "Renamed" });

      const { sql, params } = render(captured.updateWheres[0]);
      expect(sql).toContain('"org_units"."org_id" = $');
      expect(params).toEqual(expect.arrayContaining([BRANCH_ID, OWNER]));
    });
  });

  // Ported from the deleted hard-delete route: the archive write now carries its cross-tenant assertion.
  describe("archive via updateOrgBranch", () => {
    it("refuses a foreign branch id with NotFound and writes nothing", async () => {
      const { svc, captured } = makeService([]);

      await expect(
        svc.updateOrgBranch(ATTACKER, "user-1", BRANCH_ID, { status: "ARCHIVED" }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(captured.updateWheres).toHaveLength(0);
    });

    it("scopes the archive write to the caller org", async () => {
      const { svc, captured } = makeService([BRANCH]);

      await svc.updateOrgBranch(OWNER, "user-1", BRANCH_ID, { status: "ARCHIVED" });

      const { sql, params } = render(captured.updateWheres[0]);
      expect(sql).toContain('"org_units"."org_id" = $');
      expect(params).toEqual(expect.arrayContaining([BRANCH_ID, OWNER]));
    });
  });
});
