import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.types";
import type { readMutationTickets } from "./build-ticket-mutation-policy";
import { validateBatchTransition, emitBatchStatusChanges } from "./build-ticket-batch-workflow";

jest.mock("./build-ticket-capacity", () => ({
  reserveTicketCapacity: jest.fn().mockResolvedValue(undefined),
}));

import { reserveTicketCapacity } from "./build-ticket-capacity";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = 1;

const actor: CurrentUserContext = {
  orgId: ORG, userId: "user-1", role: "OWNER",
  isOrgOwner: true, sessionId: "session", tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

type Row = Awaited<ReturnType<typeof readMutationTickets>>[number];

function makeRow(id: number, status: string): Row {
  return { id, status, version: 1, assigneeMembershipId: null, dueDate: null, priority: "MEDIUM",
    points: null, epicId: null, cycleId: null, rank: String(id * 1000), allowed: true };
}

function makeWorkflowDb(transitions: unknown[] = [], statuses: unknown[] = []) {
  let returnedTransitions = false;
  const selectFn = jest.fn(() => {
    const chain = {
      from: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
      then: (resolve: (v: unknown) => unknown) => {
        const data = returnedTransitions ? statuses : transitions;
        returnedTransitions = !returnedTransitions;
        return Promise.resolve(data).then(resolve);
      },
    };
    return chain;
  });
  const insert = jest.fn(() => ({ values: jest.fn().mockResolvedValue(undefined) }));
  const execute = jest.fn().mockResolvedValue([]);
  return { db: { select: selectFn, insert, execute } as unknown as Db, insert, execute };
}

describe("validateBatchTransition — capacity reservation uses only the changing rows", () => {
  beforeEach(() => {
    (reserveTicketCapacity as jest.Mock).mockClear();
  });

  it("passes changed.length as the incoming count, not rows.length when some rows are already at the target status", async () => {
    const rows = [makeRow(1, "DONE"), makeRow(2, "TODO"), makeRow(3, "TODO")];
    const { db } = makeWorkflowDb([], [{ id: 1, name: "DONE", wipLimit: null }]);

    await validateBatchTransition(db, actor, PROJECT_ID, rows, "DONE", "MEMBER");

    expect(reserveTicketCapacity).toHaveBeenCalledTimes(1);
    const [, , , incoming, excludedIds] = (reserveTicketCapacity as jest.Mock).mock.calls[0] as [
      unknown, string, number, Array<{status: string; count: number}>, number[]
    ];
    expect(incoming).toEqual([{ status: "DONE", count: 2 }]);
    expect(excludedIds).toEqual([2, 3]);
  });

  it("does not call reserveTicketCapacity when every row is already at the target status", async () => {
    const rows = [makeRow(1, "DONE"), makeRow(2, "DONE")];
    const { db } = makeWorkflowDb([], [{ id: 1, name: "DONE", wipLimit: null }]);

    await validateBatchTransition(db, actor, PROJECT_ID, rows, "DONE", "MEMBER");

    expect(reserveTicketCapacity).not.toHaveBeenCalled();
  });

  it("calls reserveTicketCapacity with all rows when every row is changing status", async () => {
    const rows = [makeRow(1, "TODO"), makeRow(2, "TODO")];
    const { db } = makeWorkflowDb([], [{ id: 1, name: "DONE", wipLimit: null }]);

    await validateBatchTransition(db, actor, PROJECT_ID, rows, "DONE", "MEMBER");

    expect(reserveTicketCapacity).toHaveBeenCalledTimes(1);
    const [, , , incoming, excludedIds] = (reserveTicketCapacity as jest.Mock).mock.calls[0] as [
      unknown, string, number, Array<{status: string; count: number}>, number[]
    ];
    expect(incoming).toEqual([{ status: "DONE", count: 2 }]);
    expect(excludedIds).toEqual([1, 2]);
  });
});

describe("emitBatchStatusChanges — outbox events emitted only for transitioning tickets", () => {
  it("emits one event per row whose status differs from the target", async () => {
    const rows = [makeRow(1, "TODO"), makeRow(2, "DONE"), makeRow(3, "IN_PROGRESS")];
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const db = { insert: jest.fn().mockReturnValue({ values: insertValues }) } as unknown as Db;

    await emitBatchStatusChanges(db, actor, PROJECT_ID, rows, "DONE", new Date());

    expect(insertValues).toHaveBeenCalledTimes(1);
    const emitted: Array<{aggregateId: string; payload: {previousStatus: string}}> =
      insertValues.mock.calls[0]?.[0] ?? [];
    expect(emitted).toHaveLength(2);
    const ids = emitted.map(e => Number(e.aggregateId));
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    expect(ids).not.toContain(2);
  });

  it("emits no events when every row is already at the target status", async () => {
    const rows = [makeRow(1, "DONE"), makeRow(2, "DONE")];
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const db = { insert: jest.fn().mockReturnValue({ values: insertValues }) } as unknown as Db;

    await emitBatchStatusChanges(db, actor, PROJECT_ID, rows, "DONE", new Date());

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("records the pre-mutation status as previousStatus in every event payload", async () => {
    const rows = [makeRow(1, "TODO"), makeRow(2, "IN_REVIEW")];
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const db = { insert: jest.fn().mockReturnValue({ values: insertValues }) } as unknown as Db;

    await emitBatchStatusChanges(db, actor, PROJECT_ID, rows, "DONE", new Date());

    const emitted: Array<{payload: {previousStatus: string; newStatus: string}}> =
      insertValues.mock.calls[0]?.[0] ?? [];
    const prev = emitted.map(e => e.payload.previousStatus).sort();
    expect(prev).toEqual(["IN_REVIEW", "TODO"]);
    expect(emitted.every(e => e.payload.newStatus === "DONE")).toBe(true);
  });

  it("increments aggregateVersion beyond the stored row version in each event", async () => {
    const rows = [makeRow(1, "TODO")];
    if (rows[0]) rows[0].version = 5;
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const db = { insert: jest.fn().mockReturnValue({ values: insertValues }) } as unknown as Db;

    await emitBatchStatusChanges(db, actor, PROJECT_ID, rows, "DONE", new Date());

    const emitted: Array<{aggregateVersion: number}> = insertValues.mock.calls[0]?.[0] ?? [];
    expect(emitted[0]?.aggregateVersion).toBe(6);
  });
});
