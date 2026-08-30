import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";

const OWNER_ORG = "org-owner";
const PROJECT_ID = 10;

function buildSelectChain(resolvedValue: unknown) {
  const whereFn = jest.fn().mockResolvedValue(resolvedValue);
  const fromFn = jest.fn().mockReturnValue({ where: whereFn });
  const selectFn = jest.fn().mockReturnValue({ from: fromFn });
  return { selectFn, fromFn, whereFn };
}

function makeTransactionMock(
  existenceRows: Array<{ id: number }>,
  statusRows: Array<{ name: string }>,
  updateRows: Array<{ id: number }>,
) {
  let selectCallIndex = 0;
  const selectResponses = [existenceRows, statusRows];

  const selectFn = jest.fn().mockImplementation(() => {
    const value = selectResponses[selectCallIndex] ?? statusRows;
    selectCallIndex++;
    return {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(value),
      }),
    };
  });

  const updateFn = jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(updateRows),
      }),
    }),
  });

  const executeFn = jest.fn().mockResolvedValue([{ count: "0" }]);

  const tx = { select: selectFn, update: updateFn, execute: executeFn };

  return { tx };
}

function makeDb(memberRow: unknown, tx: unknown) {
  return {
    query: {
      projectMembers: {
        findFirst: jest.fn().mockResolvedValue(memberRow),
      },
    },
    transaction: jest.fn().mockImplementation(
      async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    ),
  } as unknown as Db;
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("ProjectsTicketsQueryService.bulkUpdate — ROW-74 isolation", () => {
  it("DENY — cross-tenant ticket IDs resolve empty; NotFoundException is thrown (404 semantics)", async () => {
    const { tx } = makeTransactionMock([], [{ name: "TODO" }], []);
    const db = makeDb({ id: 1 }, tx);
    const cache = { del: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new ProjectsTicketsQueryService(db, cache);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: false } as never;

    await expect(
      svc.bulkUpdate(u, PROJECT_ID, { ticketIds: [9999], status: "TODO" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("CONTROL — same-org ticket IDs resolve; update returns affected count", async () => {
    const ticketRows = [{ id: 1 }, { id: 2 }];
    const { tx } = makeTransactionMock(ticketRows, [{ name: "TODO" }], ticketRows);
    const db = makeDb({ id: 1 }, tx);
    const cache = { del: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new ProjectsTicketsQueryService(db, cache);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: false } as never;

    const result = await svc.bulkUpdate(u, PROJECT_ID, {
      ticketIds: [1, 2],
      status: "TODO",
    });

    expect(result.updated).toBe(2);
    expect(result.ticketIds).toEqual([1, 2]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("DENY — partial cross-org batch (1 valid + 1 cross-org) throws NotFoundException", async () => {
    const { tx } = makeTransactionMock([{ id: 1 }], [{ name: "TODO" }], [{ id: 1 }]);
    const db = makeDb({ id: 1 }, tx);
    const cache = { del: jest.fn() } as never;
    const svc = new ProjectsTicketsQueryService(db, cache);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: false } as never;

    await expect(
      svc.bulkUpdate(u, PROJECT_ID, { ticketIds: [1, 9999], status: "TODO" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("DENY — non-project-member is rejected with ForbiddenException before transaction starts", async () => {
    const { tx } = makeTransactionMock([], [], []);
    const db = makeDb(null, tx);
    const cache = { del: jest.fn() } as never;
    const svc = new ProjectsTicketsQueryService(db, cache);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: false } as never;

    await expect(
      svc.bulkUpdate(u, PROJECT_ID, { ticketIds: [1], status: "TODO" }),
    ).rejects.toThrow(ForbiddenException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("CONTROL — org owner bypasses membership check and enters transaction", async () => {
    const ticketRows = [{ id: 1 }];
    const { tx } = makeTransactionMock(ticketRows, [], ticketRows);
    const db = makeDb(null, tx);
    const cache = { del: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new ProjectsTicketsQueryService(db, cache);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true } as never;

    await expect(
      svc.bulkUpdate(u, PROJECT_ID, { ticketIds: [1], priority: "HIGH" }),
    ).resolves.not.toThrow();

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});
