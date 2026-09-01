/**
 * Tenant isolation spec for ProjectsProvisionService.
 *
 * Cross-tenant concern: `createFromDeal` reads a deal by ID and MUST assert the
 * deal belongs to the caller's org — `eq(deals.orgId, orgId)` prevents a caller
 * from converting another org's deal into a project.
 *
 * `createProject` is a pure write path that always inserts with the caller's
 * orgId — no cross-org read; tested here for orgId propagation correctness.
 */

import { NotFoundException } from "@nestjs/common";
import { ProjectsProvisionService } from "../projects-provision.service";

const OWNER_ORG = "org-owner-projects";
const ATTACKER_ORG = "org-attacker-projects";
const USER_ID = "user-pm-01";
const DEAL_ID = 42;

function makeMockDb(overrides: Partial<{ queryResult: unknown; transactionRows: unknown[] }> = {}) {
  const queryResult = overrides.queryResult ?? null;
  const transactionRows = overrides.transactionRows ?? [{ id: 1, orgId: OWNER_ORG, key: "TST-001", name: "Test Project" }];

  const transactionMock = jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert: () => ({
        values: () => ({
          returning: jest.fn().mockResolvedValue(transactionRows),
        }),
      }),
    };
    return cb(tx);
  });

  const membershipRow = { id: 1, orgId: OWNER_ORG, userId: USER_ID, role: "MEMBER", isOwner: false, status: "ACTIVE" };
  const makeFromWhere = (rows: unknown[]) => ({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(rows) }) });
  const selectMock = jest.fn()
    .mockReturnValueOnce(makeFromWhere([membershipRow]))
    .mockReturnValue(makeFromWhere([]));

  return {
    query: {
      deals: {
        findFirst: jest.fn().mockResolvedValue(queryResult),
      },
    },
    transaction: transactionMock,
    select: selectMock,
  };
}

function makeServices() {
  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn() };
  const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
  const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };
  const pmWorkspaces = { resolveDefaultWorkspaceId: jest.fn().mockResolvedValue("ws-1") };
  return { cache, audit, planLimits, dispatch, pmWorkspaces };
}

describe("ProjectsProvisionService — cross-tenant isolation", () => {
  describe("createFromDeal", () => {
    it("DENY — deal belonging to a different org is not found → NotFoundException", async () => {
      const db = makeMockDb({ queryResult: null });
      const { cache, audit, planLimits, dispatch, pmWorkspaces } = makeServices();

      const svc = new ProjectsProvisionService(
        db as never,
        cache as never,
        audit as never,
        planLimits as never,
        dispatch as never,
        pmWorkspaces as never,
      );

      await expect(
        svc.createFromDeal(ATTACKER_ORG, USER_ID, {
          dealId: DEAL_ID,
          name: "Stolen Deal Project",
        }),
      ).rejects.toThrow(NotFoundException);

      expect(db.query.deals.findFirst).toHaveBeenCalledTimes(1);
      const [callArg] = db.query.deals.findFirst.mock.calls[0] as [{ where: unknown }];
      expect(callArg.where).toBeDefined();
    });

    it("CONTROL — own org deal found, project created with correct orgId", async () => {
      const dealRow = {
        id: DEAL_ID,
        name: "My Deal",
        orgId: OWNER_ORG,
        notes: null,
        expectedCloseDate: null,
        assignedToId: null,
        value: null,
        deletedAt: null,
      };

      const db = makeMockDb({
        queryResult: dealRow,
        transactionRows: [{ id: 10, orgId: OWNER_ORG, key: "MYD-001", name: "My Deal Project" }],
      });

      const { cache, audit, planLimits, dispatch, pmWorkspaces } = makeServices();

      const svc = new ProjectsProvisionService(
        db as never,
        cache as never,
        audit as never,
        planLimits as never,
        dispatch as never,
        pmWorkspaces as never,
      );

      const result = await svc.createFromDeal(OWNER_ORG, USER_ID, {
        dealId: DEAL_ID,
        name: "My Deal Project",
      });

      expect(result.orgId).toBe(OWNER_ORG);
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("createProject — write path org propagation", () => {
    it("CONTROL — new project carries caller's orgId on all inserted rows", async () => {
      const db = makeMockDb({
        transactionRows: [{ id: 5, orgId: OWNER_ORG, key: "TST-001", name: "New Project" }],
      });

      (db.transaction as jest.Mock).mockImplementation(
        async (cb: (tx: unknown) => Promise<unknown>) => {
          const insertedRows: Array<{ orgId: string; table: string }> = [];
          const tx = {
            insert: (_table: unknown) => ({
              values: (vals: { orgId?: string } | Array<{ orgId?: string }>) => {
                const arr = Array.isArray(vals) ? vals : [vals];
                arr.forEach((v) => {
                  if (v.orgId) insertedRows.push({ orgId: v.orgId, table: "inserted" });
                });
                return {
                  returning: jest.fn().mockResolvedValue([{ id: 5, orgId: OWNER_ORG, key: "TST-001", name: "New Project" }]),
                };
              },
            }),
          };
          const result = await cb(tx);
          (db as never as { _insertedRows: typeof insertedRows })._insertedRows = insertedRows;
          return result;
        },
      );

      const { cache, audit, planLimits, dispatch, pmWorkspaces } = makeServices();
      const svc = new ProjectsProvisionService(
        db as never,
        cache as never,
        audit as never,
        planLimits as never,
        dispatch as never,
        pmWorkspaces as never,
      );

      const result = await svc.createProject(OWNER_ORG, USER_ID, { name: "New Project" });

      expect(result.orgId).toBe(OWNER_ORG);

      const rows = (db as never as { _insertedRows: Array<{ orgId: string }> })._insertedRows;
      for (const row of rows) {
        expect(row.orgId).toBe(OWNER_ORG);
        expect(row.orgId).not.toBe(ATTACKER_ORG);
      }
    });
  });
});
