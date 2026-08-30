import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { WorkflowsCrudService } from "./workflows-crud.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value as object)) return [];

  seen.add(value as object);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeSelectChain(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  where.mockReturnValue({ orderBy, limit });

  const leftJoin = jest.fn();
  leftJoin.mockReturnValue({ where });

  const from = jest.fn();
  from.mockReturnValue({ where, leftJoin });

  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

describe("WorkflowsCrudService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner-uuid";
  const ATTACKER_ORG = "org-attacker-uuid";
  const WORKFLOW_ID = "wf-uuid-1";
  const USER_ID = "user-uuid-1";

  const WORKFLOW_ROW = {
    id: WORKFLOW_ID,
    orgId: OWNER_ORG,
    name: "My Workflow",
    description: null,
    status: "draft",
    version: 1,
    createdBy: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdByName: "Alice",
    createdByEmail: "alice@example.com",
  };

  describe("listWorkflows", () => {
    it("returns empty list when no workflows exist for attacker org (cross-tenant isolation)", async () => {
      const { db, where } = makeSelectChain([]);
      const svc = new WorkflowsCrudService(db);

      const result = await svc.listWorkflows(ATTACKER_ORG, {
        cursor: undefined,
        limit: 20,
        sort: "createdAt",
        direction: "desc",
      });

      expect(result.data).toHaveLength(0);
      expect(result.pagination.nextCursor).toBeNull();
      expect(where).toHaveBeenCalledTimes(1);
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
    });

    it("returns workflows for the owning org (control — same-tenant access works)", async () => {
      const { db } = makeSelectChain([WORKFLOW_ROW]);
      const svc = new WorkflowsCrudService(db);

      const result = await svc.listWorkflows(OWNER_ORG, {
        cursor: undefined,
        limit: 20,
        sort: "createdAt",
        direction: "desc",
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({ id: WORKFLOW_ID });
    });
  });

  describe("getWorkflow", () => {
    it("throws NotFoundException when workflow belongs to a different org (cross-tenant isolation)", async () => {
      const { db } = makeSelectChain([]);
      const svc = new WorkflowsCrudService(db);

      await expect(svc.getWorkflow(ATTACKER_ORG, WORKFLOW_ID)).rejects.toThrow(NotFoundException);
    });

    it("returns the workflow for the owning org (control)", async () => {
      const { db } = makeSelectChain([WORKFLOW_ROW]);
      (db as unknown as { select: jest.Mock }).select
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ leftJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([WORKFLOW_ROW]) }) }) }) })
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }) });

      const svc = new WorkflowsCrudService(db);
      await expect(svc.getWorkflow(OWNER_ORG, WORKFLOW_ID)).resolves.toMatchObject({ id: WORKFLOW_ID });
    });
  });

  describe("deleteWorkflow", () => {
    it("throws NotFoundException when workflow belongs to a different org (cross-tenant isolation)", async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const db = {
        query: { workflows: { findFirst } },
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([]),
        insert: jest.fn().mockReturnThis(),
        values: jest.fn().mockResolvedValue(undefined),
      } as unknown as Db;

      const svc = new WorkflowsCrudService(db);
      await expect(svc.deleteWorkflow(ATTACKER_ORG, USER_ID, WORKFLOW_ID)).rejects.toThrow(NotFoundException);
    });

    it("deletes the workflow for the owning org (control)", async () => {
      const findFirst = jest.fn().mockResolvedValue({ id: WORKFLOW_ID });
      const deleteWhere = jest.fn().mockResolvedValue([]);
      const insertValues = jest.fn().mockResolvedValue(undefined);
      const db = {
        query: { workflows: { findFirst } },
        delete: jest.fn().mockReturnValue({ where: deleteWhere }),
        insert: jest.fn().mockReturnValue({ values: insertValues }),
      } as unknown as Db;

      const svc = new WorkflowsCrudService(db);
      await expect(svc.deleteWorkflow(OWNER_ORG, USER_ID, WORKFLOW_ID)).resolves.not.toThrow();
      expect(deleteWhere).toHaveBeenCalledTimes(1);
    });
  });

  describe("updateWorkflow", () => {
    it("throws NotFoundException when workflow belongs to a different org (cross-tenant isolation)", async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const db = {
        query: { workflows: { findFirst } },
      } as unknown as Db;

      const svc = new WorkflowsCrudService(db);
      await expect(svc.updateWorkflow(ATTACKER_ORG, USER_ID, WORKFLOW_ID, { name: "Hacked" })).rejects.toThrow(
        NotFoundException,
      );
    });

    it("updates the workflow for the owning org (control)", async () => {
      const findFirst = jest.fn().mockResolvedValue({ id: WORKFLOW_ID });
      const updateReturning = jest.fn().mockResolvedValue([{ ...WORKFLOW_ROW, name: "Updated" }]);
      const insertValues = jest.fn().mockResolvedValue(undefined);
      const db = {
        query: { workflows: { findFirst } },
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: updateReturning }) }) }),
        insert: jest.fn().mockReturnValue({ values: insertValues }),
      } as unknown as Db;

      const svc = new WorkflowsCrudService(db);
      const result = await svc.updateWorkflow(OWNER_ORG, USER_ID, WORKFLOW_ID, { name: "Updated" });
      expect(result).toMatchObject({ name: "Updated" });
    });
  });

  describe("publishWorkflow — write includes orgId (TOCTOU guard)", () => {
    it("throws NotFoundException when workflow belongs to a different org (cross-tenant deny)", async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const db = {
        query: { workflows: { findFirst } },
      } as unknown as Db;

      const svc = new WorkflowsCrudService(db);
      await expect(
        svc.publishWorkflow(ATTACKER_ORG, USER_ID, WORKFLOW_ID, { definitionJson: {} }),
      ).rejects.toThrow(NotFoundException);
    });

    it("includes orgId in the update where clause for the owning org (control)", async () => {
      const findFirst = jest.fn().mockResolvedValue({ id: WORKFLOW_ID, version: 1 });
      const updateWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ ...WORKFLOW_ROW, status: "published" }]) });
      const insertReturning = jest.fn().mockResolvedValue([{ id: 99, version: 2 }]);
      const auditInsertValues = jest.fn().mockResolvedValue(undefined);

      let insertCallCount = 0;
      const db = {
        query: { workflows: { findFirst } },
        transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            insert: jest.fn().mockImplementation(() => {
              insertCallCount++;
              if (insertCallCount === 1)
                return { values: jest.fn().mockReturnValue({ returning: insertReturning }) };
              return { values: auditInsertValues };
            }),
            update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
          };
          return cb(tx);
        }),
      } as unknown as Db;

      const svc = new WorkflowsCrudService(db);
      await svc.publishWorkflow(OWNER_ORG, USER_ID, WORKFLOW_ID, { definitionJson: {} });

      expect(updateWhere).toHaveBeenCalledTimes(1);
      const whereArg = updateWhere.mock.calls[0]?.[0];
      expect(sqlValues(whereArg)).toContain(OWNER_ORG);
      expect(sqlValues(whereArg)).toContain(WORKFLOW_ID);
    });
  });
});
