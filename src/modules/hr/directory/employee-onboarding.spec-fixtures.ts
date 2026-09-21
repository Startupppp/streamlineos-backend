import { getTableName, type Table } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { MembershipAdmissionService } from "../../organization/core/membership-admission.service";
import { EmployeeOnboardingService } from "./employee-onboarding.service";

export interface Script {
  selects?: Record<string, unknown[][]>;
  returning?: Record<string, unknown[]>;
  findFirst?: unknown[];
}

export interface Harness {
  db: Db;
  inserted: { table: string; values: unknown }[];
  updated: { table: string; set: unknown }[];
  deleted: string[];
}

function tableName(target: unknown): string {
  return getTableName(target as Table);
}

export function makeHarness(script: Script): Harness {
  const inserted: { table: string; values: unknown }[] = [];
  const updated: { table: string; set: unknown }[] = [];
  const deleted: string[] = [];

  const selects = new Map<string, unknown[][]>(
    Object.entries(script.selects ?? {}),
  );
  const findFirstQueue = [...(script.findFirst ?? [])];

  function selectBuilder() {
    let current = "";
    const builder: Record<string, unknown> = {};
    const chain = (): Record<string, unknown> => builder;
    builder["from"] = jest.fn((target: unknown) => {
      current = tableName(target);
      return builder;
    });
    builder["where"] = jest.fn(chain);
    builder["innerJoin"] = jest.fn(chain);
    builder["leftJoin"] = jest.fn(chain);
    builder["orderBy"] = jest.fn(chain);
    builder["groupBy"] = jest.fn(chain);
    builder["offset"] = jest.fn(chain);
    builder["for"] = jest.fn(chain);
    const resolve = (): Promise<unknown[]> =>
      Promise.resolve(selects.get(current)?.shift() ?? []);
    builder["limit"] = jest.fn(resolve);
    builder["then"] = (onFulfilled: (value: unknown) => unknown) =>
      resolve().then(onFulfilled);
    return builder;
  }

  function insertChain(name: string) {
    const terminal: Record<string, unknown> = {};
    const rows = (): Promise<unknown[]> =>
      Promise.resolve(script.returning?.[name] ?? []);
    terminal["returning"] = jest.fn(rows);
    terminal["onConflictDoNothing"] = jest.fn(() => terminal);
    terminal["onConflictDoUpdate"] = jest.fn(() => terminal);
    terminal["then"] = (onFulfilled: (value: unknown) => unknown) =>
      rows().then(onFulfilled);
    return terminal;
  }

  const queryProxy = new Proxy({} as Record<string, unknown>, {
    get: () => ({
      findFirst: jest.fn(() => Promise.resolve(findFirstQueue.shift() ?? null)),
      findMany: jest.fn(() => Promise.resolve([])),
    }),
  });

  const executor: Record<string, unknown> = {
    select: jest.fn(() => selectBuilder()),
    query: queryProxy,
    execute: jest.fn(() => Promise.resolve([])),
    insert: jest.fn((target: unknown) => {
      const name = tableName(target);
      return {
        values: jest.fn((values: unknown) => {
          inserted.push({ table: name, values });
          return insertChain(name);
        }),
      };
    }),
    update: jest.fn((target: unknown) => {
      const name = tableName(target);
      return {
        set: jest.fn((set: unknown) => {
          updated.push({ table: name, set });
          const terminal: Record<string, unknown> = {};
          const rows = (): Promise<unknown[]> =>
            Promise.resolve(script.returning?.[name] ?? []);
          terminal["returning"] = jest.fn(rows);
          terminal["where"] = jest.fn(() => terminal);
          terminal["then"] = (onFulfilled: (value: unknown) => unknown) =>
            rows().then(onFulfilled);
          return terminal;
        }),
      };
    }),
    delete: jest.fn((target: unknown) => {
      deleted.push(tableName(target));
      const terminal: Record<string, unknown> = {};
      terminal["where"] = jest.fn(() => Promise.resolve([]));
      return terminal;
    }),
  };

  executor["transaction"] = jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
    fn(executor),
  );

  return { db: executor as unknown as Db, inserted, updated, deleted };
}

export interface Collaborators {
  ensureFromUser: jest.Mock;
  recordSeatEvents: jest.Mock;
  assertWithinLimit: jest.Mock;
  service: EmployeeOnboardingService;
}

export function buildService(db: Db): Collaborators {
  const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
  const recordSeatEvents = jest.fn().mockResolvedValue(undefined);
  const ensureFromUser = jest
    .fn()
    .mockResolvedValue({ personId: 1, employmentId: 10, createdPerson: true, createdEmployment: true });

  const admission = new MembershipAdmissionService(
    { assertWithinLimit } as never,
    { recordSeatEvents } as never,
  );

  const service = new EmployeeOnboardingService(
    db,
    {
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateMany: jest.fn().mockResolvedValue(undefined),
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
      invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
    } as never,
    { logCritical: jest.fn().mockResolvedValue(undefined) } as never,
    { sendWelcomeEmail: jest.fn().mockResolvedValue(undefined) } as never,
    { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as never,
    { dispatch: jest.fn() } as never,
    { ensureFromUser } as never,
    {
      canManageOrganizationMembership: jest.fn().mockResolvedValue(true),
      resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
      membersWithPermission: jest.fn().mockResolvedValue([]),
    } as never,
    admission,
    { checkManager: jest.fn().mockResolvedValue({ ok: true, managerEmploymentId: 5 }), assign: jest.fn().mockResolvedValue({ status: "written", employmentId: 10, managerEmploymentId: 5 }) } as never,
  );

  return { service, ensureFromUser, recordSeatEvents, assertWithinLimit };
}
