/**
 * Tenant-isolation coverage for BuildAutomationActionExecutor.
 *
 * File under test: src/modules/build/core/build-automation-actions.service.ts
 *
 * Every action that mutates a ticket goes through a shared WHERE predicate:
 *
 *   and(
 *     eq(tickets.id,        ticketId),
 *     eq(tickets.orgId,     orgId),
 *     eq(tickets.projectId, projectId),
 *     isNull(tickets.deletedAt),
 *   )
 *
 * An attacker that calls execute() with their own orgId can never reach a
 * ticket row that carries a different org's orgId — the database simply
 * returns 0 rows for the update.  The cross-project predicate gives the
 * same guarantee within the same org: a caller cannot update a ticket
 * that belongs to a project they did not supply.
 *
 * Test structure (modelled on projects-automations-tenant-isolation.spec.ts):
 *   1. Cross-org DENY — WHERE clause is bound to ATTACKER_ORG, not OWNER_ORG
 *   2. Cross-project DENY — WHERE clause is bound to FOREIGN_PROJECT_ID, not
 *      OWNER_PROJECT_ID
 *   3. Positive control — call resolves for the correctly-scoped actor and
 *      WHERE clause carries OWNER_ORG + OWNER_PROJECT_ID
 *   4. set_status early-exit guard — the preliminary projectStatuses lookup
 *      also carries orgId + projectId, preventing cross-org status poisoning
 */

import { BuildAutomationActionExecutor } from "./build-automation-actions.service";
import type { Db } from "../../../../db/drizzle.module";

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
  return { db: { update } as unknown as Db, where };
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("BuildAutomationActionExecutor — cross-org tenant isolation (set_priority)", () => {
  it("binds attacker orgId in the WHERE clause — cross-org ticket is unreachable (DENY)", async () => {
    const { db, where } = makeUpdateDb();
    const executor = new BuildAutomationActionExecutor(db);

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
    const executor = new BuildAutomationActionExecutor(db);

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
    const executor = new BuildAutomationActionExecutor(db);

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
  function makeStatusLookupDb(statusRow: unknown) {
    const returning = jest.fn().mockResolvedValue([]);
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
    const findFirst = jest.fn().mockImplementation(({ where: predicate }: { where: unknown }) => {
      statusFindFirstPredicate = predicate;
      return Promise.resolve(statusRow);
    });

    const db = {
      query: { projectStatuses: { findFirst } },
      transaction,
    } as unknown as Db;

    return { db, findFirst, txWhere, getStatusPredicate: () => statusFindFirstPredicate };
  }

  it("projectStatuses lookup carries attacker orgId — cross-org status lookup is isolated (DENY path)", async () => {
    const { db, findFirst, getStatusPredicate } = makeStatusLookupDb(undefined);
    const executor = new BuildAutomationActionExecutor(db);

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
    const { db, findFirst } = makeStatusLookupDb({ id: 7 });
    const executor = new BuildAutomationActionExecutor(db);

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
