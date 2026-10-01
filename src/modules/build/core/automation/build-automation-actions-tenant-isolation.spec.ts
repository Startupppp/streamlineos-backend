import { BuildAutomationActionExecutor } from "./build-automation-actions.service";
import type { Db } from "../../../../db/drizzle.module";
import { assertTransitionAllowed } from "../tickets/projects-tickets-workflow-utils";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";

jest.mock("../tickets/projects-tickets-workflow-utils", () => ({
  assertTransitionAllowed: jest.fn(),
}));

jest.mock("../../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn() },
}));

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
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const OWNER_PROJECT_ID = 10;
const FOREIGN_PROJECT_ID = 99;
const TICKET_ID = 42;
const RULE_ID = 1;

function makeUpdateDb() {
  const returning = jest.fn().mockResolvedValue([]);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  const db = {
    update,
    query: {
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
  } as unknown as Db;
  return { db, where };
}

function makeActivity() {
  return { logTicketActivity: jest.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(assertTransitionAllowed).mockResolvedValue(undefined);
  jest.mocked(OutboxWriter.emit).mockResolvedValue(undefined);
});

describe("BuildAutomationActionExecutor — cross-org tenant isolation (set_priority)", () => {
  it("binds attacker orgId in the WHERE clause — cross-org ticket is unreachable (DENY)", async () => {
    const { db, where } = makeUpdateDb();
    const executor = new BuildAutomationActionExecutor(db, makeActivity() as never);

    await executor.execute(
      ATTACKER_ORG,
      OWNER_PROJECT_ID,
      TICKET_ID,
      RULE_ID,
      { type: "set_priority", value: "HIGH" },
      null,
    );

    expect(where).toHaveBeenCalledTimes(1);
    const predicate = where.mock.calls[0]?.[0];
    const values = sqlValues(predicate);
    expect(values).toContain(ATTACKER_ORG);
    expect(values).not.toContain(OWNER_ORG);
  });

  it("binds projectId in the WHERE clause — cross-project ticket is unreachable (DENY)", async () => {
    const { db, where } = makeUpdateDb();
    const executor = new BuildAutomationActionExecutor(db, makeActivity() as never);

    await executor.execute(
      ATTACKER_ORG,
      FOREIGN_PROJECT_ID,
      TICKET_ID,
      RULE_ID,
      { type: "set_priority", value: "HIGH" },
      null,
    );

    expect(where).toHaveBeenCalledTimes(1);
    const predicate = where.mock.calls[0]?.[0];
    const values = sqlValues(predicate);
    expect(values).toContain(FOREIGN_PROJECT_ID);
    expect(values).not.toContain(OWNER_PROJECT_ID);
  });

  it("resolves without error and WHERE clause carries owner org + project (positive control)", async () => {
    const { db, where } = makeUpdateDb();
    const executor = new BuildAutomationActionExecutor(db, makeActivity() as never);

    await expect(
      executor.execute(
        OWNER_ORG,
        OWNER_PROJECT_ID,
        TICKET_ID,
        RULE_ID,
        { type: "set_priority", value: "HIGH" },
        null,
      ),
    ).resolves.toBeUndefined();

    expect(where).toHaveBeenCalledTimes(1);
    const predicate = where.mock.calls[0]?.[0];
    const values = sqlValues(predicate);
    expect(values).toContain(OWNER_ORG);
    expect(values).toContain(OWNER_PROJECT_ID);
    expect(values).toContain(TICKET_ID);
  });
});

describe("BuildAutomationActionExecutor — cross-org isolation via set_status guard", () => {
  function makeStatusLookupDb(statusRow: unknown, currentStatus: string | null = "TODO") {
    const returning = jest.fn().mockResolvedValue([{ version: 2 }]);
    const txWhere = jest.fn().mockReturnValue({ returning });
    const txSet = jest.fn().mockReturnValue({ where: txWhere });
    const txUpdate = jest.fn().mockReturnValue({ set: txSet });
    const txInsert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
    });
    const transaction = jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        update: txUpdate,
        insert: txInsert,
        execute: jest.fn().mockResolvedValue([]),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
      }),
    );

    let statusFindFirstPredicate: unknown = undefined;
    const findFirstStatus = jest.fn().mockImplementation(({ where: predicate }: { where: unknown }) => {
      statusFindFirstPredicate = predicate;
      return Promise.resolve(statusRow);
    });

    const findFirstTicket = jest.fn().mockResolvedValue(
      currentStatus !== null ? { id: TICKET_ID, status: currentStatus, version: 1 } : undefined,
    );

    const db = {
      query: {
        projectStatuses: { findFirst: findFirstStatus },
        tickets: { findFirst: findFirstTicket },
      },
      transaction,
    } as unknown as Db;

    return { db, findFirst: findFirstStatus, txWhere, getStatusPredicate: () => statusFindFirstPredicate };
  }

  it("projectStatuses lookup carries attacker orgId — cross-org status lookup is isolated (DENY path)", async () => {
    const { db, findFirst, getStatusPredicate } = makeStatusLookupDb(undefined);
    const executor = new BuildAutomationActionExecutor(db, makeActivity() as never);

    await executor.execute(
      ATTACKER_ORG,
      FOREIGN_PROJECT_ID,
      TICKET_ID,
      RULE_ID,
      { type: "set_status", value: "DONE" },
      null,
    );

    expect(findFirst).toHaveBeenCalledTimes(1);
    const values = sqlValues(getStatusPredicate());
    expect(values).toContain(ATTACKER_ORG);
    expect(values).not.toContain(OWNER_ORG);
    expect(values).toContain(FOREIGN_PROJECT_ID);
    expect(values).not.toContain(OWNER_PROJECT_ID);
  });

  it("resolves and executes the transaction when status exists in the correct project (positive control)", async () => {
    const { db, findFirst } = makeStatusLookupDb({ id: 7 }, "TODO");
    const executor = new BuildAutomationActionExecutor(db, makeActivity() as never);

    await expect(
      executor.execute(
        OWNER_ORG,
        OWNER_PROJECT_ID,
        TICKET_ID,
        RULE_ID,
        { type: "set_status", value: "DONE" },
        null,
      ),
    ).resolves.toBeUndefined();

    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});
