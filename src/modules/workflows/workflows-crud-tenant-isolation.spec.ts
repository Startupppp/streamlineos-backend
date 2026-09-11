import { ConflictException, NotFoundException } from "@nestjs/common";
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
    function makeDeleteDb(workflowRow: { id: string } | null) {
      const findFirst = jest.fn().mockResolvedValue(workflowRow);
      const updateWhere = jest.fn().mockResolvedValue([]);
      const deleteWhere = jest.fn().mockResolvedValue([]);
      const insertValues = jest.fn().mockResolvedValue(undefined);
      const tx = {
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
        delete: jest.fn().mockReturnValue({ where: deleteWhere }),
        insert: jest.fn().mockReturnValue({ values: insertValues }),
      };
      const db = {
        query: { workflows: { findFirst } },
        transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
      } as unknown as Db;
      return { db, tx, updateWhere, deleteWhere, insertValues };
    }

    it("throws NotFoundException when workflow belongs to a different org (cross-tenant isolation)", async () => {
      const { db } = makeDeleteDb(null);
      const svc = new WorkflowsCrudService(db);
      await expect(svc.deleteWorkflow(ATTACKER_ORG, USER_ID, WORKFLOW_ID)).rejects.toThrow(NotFoundException);
      expect((db as unknown as { transaction: jest.Mock }).transaction).not.toHaveBeenCalled();
    });

    it("detaches audit logs then deletes the workflow in one transaction (control)", async () => {
      const { db, updateWhere, deleteWhere, insertValues } = makeDeleteDb({ id: WORKFLOW_ID });
      const svc = new WorkflowsCrudService(db);
      await expect(svc.deleteWorkflow(OWNER_ORG, USER_ID, WORKFLOW_ID)).resolves.not.toThrow();
      expect(updateWhere).toHaveBeenCalledTimes(1);
      expect(deleteWhere).toHaveBeenCalledTimes(1);
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ event: "deleted", orgId: OWNER_ORG }),
      );
    });

    it("sets workflowId=null on existing audit logs (bites if reverted: delete would fail 23503)", async () => {
      const findFirst = jest.fn().mockResolvedValue({ id: WORKFLOW_ID });
      const callOrder: string[] = [];
      const updateWhere = jest.fn().mockImplementation(() => { callOrder.push("update"); return Promise.resolve([]); });
      const deleteWhere = jest.fn().mockImplementation(() => { callOrder.push("delete"); return Promise.resolve([]); });
      const capturedPatches: Record<string, unknown>[] = [];
      const tx = {
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockImplementation((patch: Record<string, unknown>) => {
            capturedPatches.push(patch);
            return { where: updateWhere };
          }),
        }),
        delete: jest.fn().mockReturnValue({ where: deleteWhere }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      };
      const db = {
        query: { workflows: { findFirst } },
        transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
      } as unknown as Db;

      const svc = new WorkflowsCrudService(db);
      await svc.deleteWorkflow(OWNER_ORG, USER_ID, WORKFLOW_ID);
      expect(capturedPatches[0]).toMatchObject({ workflowId: null });
      expect(callOrder).toEqual(["update", "delete"]);
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

  describe("publishWorkflow — orgId and version both guard the write", () => {
    /**
     * The read moved INSIDE the transaction, so `findFirst` is now reached
     * through `tx.query`, not `db.query`. That is the fix, not an incidental
     * refactor: read-then-compare outside the transaction was the TOCTOU that
     * let two concurrent publishes both succeed (see
     * `__tests__/workflow-publish-lost-update.db.spec.ts`).
     */
    function makePublishDb(options: {
      workflow: { id: string; version: number } | null;
      updateReturns: unknown[];
    }): { db: Db; updateWhere: jest.Mock; inserts: jest.Mock } {
      const findFirst = jest.fn().mockResolvedValue(options.workflow);
      const updateWhere = jest
        .fn()
        .mockReturnValue({ returning: jest.fn().mockResolvedValue(options.updateReturns) });
      const inserts = jest.fn();

      let insertCallCount = 0;
      const db = {
        transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            query: { workflows: { findFirst } },
            insert: jest.fn().mockImplementation(() => {
              insertCallCount++;
              inserts(insertCallCount);
              if (insertCallCount === 1)
                return {
                  values: jest
                    .fn()
                    .mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 99, version: 2 }]) }),
                };
              return { values: jest.fn().mockResolvedValue(undefined) };
            }),
            update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
          };
          return cb(tx);
        }),
      } as unknown as Db;

      return { db, updateWhere, inserts };
    }

    it("throws NotFoundException when workflow belongs to a different org (cross-tenant deny)", async () => {
      const { db } = makePublishDb({ workflow: null, updateReturns: [] });
      const svc = new WorkflowsCrudService(db);
      await expect(
        svc.publishWorkflow(ATTACKER_ORG, USER_ID, WORKFLOW_ID, { definitionJson: {} }),
      ).rejects.toThrow(NotFoundException);
    });

    it("includes orgId AND the read version in the update where clause (control)", async () => {
      const { db, updateWhere } = makePublishDb({
        workflow: { id: WORKFLOW_ID, version: 1 },
        updateReturns: [{ ...WORKFLOW_ROW, status: "published" }],
      });

      const svc = new WorkflowsCrudService(db);
      await svc.publishWorkflow(OWNER_ORG, USER_ID, WORKFLOW_ID, { definitionJson: {} });

      expect(updateWhere).toHaveBeenCalledTimes(1);
      const whereArg = updateWhere.mock.calls[0]?.[0];
      expect(sqlValues(whereArg)).toContain(OWNER_ORG);
      expect(sqlValues(whereArg)).toContain(WORKFLOW_ID);
      // The compare-and-set. Without it two publishes that both read version 1
      // both write version 2 and one is lost with a 200.
      expect(sqlValues(whereArg)).toContain(1);
    });

    it("compares against the caller's expectedVersion when one is supplied", async () => {
      const { db, updateWhere } = makePublishDb({
        workflow: { id: WORKFLOW_ID, version: 7 },
        updateReturns: [{ ...WORKFLOW_ROW, status: "published" }],
      });

      const svc = new WorkflowsCrudService(db);
      await svc.publishWorkflow(OWNER_ORG, USER_ID, WORKFLOW_ID, {
        definitionJson: {},
        expectedVersion: 5,
      });

      // A stale editor that loaded at version 5 must not publish over version 7,
      // so the predicate carries 5 and matches nothing.
      expect(sqlValues(updateWhere.mock.calls[0]?.[0])).toContain(5);
    });

    it("throws ConflictException when the compare-and-set matches no row, and writes no version", async () => {
      const { db, inserts } = makePublishDb({
        workflow: { id: WORKFLOW_ID, version: 3 },
        updateReturns: [],
      });

      const svc = new WorkflowsCrudService(db);
      await expect(
        svc.publishWorkflow(OWNER_ORG, USER_ID, WORKFLOW_ID, { definitionJson: {} }),
      ).rejects.toThrow(ConflictException);

      // The version row must not exist for a publish that lost the race — that
      // orphan is what made two live definitions possible in the first place.
      expect(inserts).not.toHaveBeenCalled();
    });
  });
});
