import { BadRequestException, HttpException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ProjectsCustomStatesService } from "./projects-custom-states.service";
import { projectStatuses } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { bulkReorderStatesSchema, type BulkReorderStatesInput } from "./dto/projects.schemas";

const ORG = "org-1";
const PROJECT_ID = 10;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG,
    isOrgOwner: true,
    principal: { type: "member", membershipId: 1 },
    ...overrides,
  } as unknown as CurrentUserContext;
}

type StateRow = { id: number; order: number };

function makeDb(rows: StateRow[]) {
  const store = { rows: [...rows], updateCalls: 0, txRolledBack: false, statements: 0 };

  const builder = (filterFn: (row: StateRow) => boolean) => ({
    limit: jest.fn().mockResolvedValue(store.rows.filter(filterFn)),
  });

  const db = {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: null }) },
      projectMembers: undefined,
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(
            store.rows.map((r) => ({ id: r.id, order: r.order })),
          ),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockImplementation(() => {
            store.updateCalls++;
            const updated = store.rows.map((r) => ({ id: r.id, order: r.order }));
            return Promise.resolve(updated.slice(0, 1));
          }),
        }),
      }),
    }),
    /*
     * The reorder is one `UPDATE … FROM (VALUES …)`. Decode the bind parameters
     * so the mock answers with exactly the ids the statement claims to move —
     * a statement that missed a state returns fewer keys and the service drops
     * it from the response, which is what makes these assertions bite.
     */
    execute: jest.fn().mockImplementation((statement: SQL) => {
      store.statements++;
      store.updateCalls++;
      const { params } = new PgDialect().sqlToQuery(statement);
      const keys: number[] = [];
      for (let i = 0; i + 1 < params.length; i += 2) {
        if (typeof params[i] !== "number") break;
        keys.push(params[i] as number);
      }
      return Promise.resolve(keys.map((key) => ({ key })));
    }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txProxy = {
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockImplementation((cols: unknown) => {
                store.updateCalls++;
                const resultRow = store.rows[0];
                return Promise.resolve(resultRow ? [{ id: resultRow.id, order: resultRow.order }] : []);
              }),
            }),
          }),
        }),
      };
      return fn(txProxy);
    }),
  } as unknown as Db;

  return { db, store };
}

const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) };

function makeService(db: Db) {
  return new ProjectsCustomStatesService(db, access as never);
}

describe("bulk-reorder — idempotent transactional update", () => {
  it("returns the reordered items when all stateIds exist in the project", async () => {
    const rows: StateRow[] = [
      { id: 1, order: 0 },
      { id: 2, order: 1 },
    ];
    const { db } = makeDb(rows);
    const service = makeService(db);

    const body: BulkReorderStatesInput = {
      items: [
        { stateId: 1, order: 1 },
        { stateId: 2, order: 0 },
      ],
    };

    const { db: db2, store } = makeDb(rows);
    const service2 = makeService(db2);
    const result = await service2.bulkReorderCustomStates(makeUser(), PROJECT_ID, body);

    expect(result.items).toEqual([
      { id: 1, order: 1 },
      { id: 2, order: 0 },
    ]);
    // One statement for the whole reorder: the atomicity a wrapping transaction
    // used to provide now comes from the statement itself.
    expect(store.statements).toBe(1);
    expect(db2.transaction).not.toHaveBeenCalled();
  });

  it("refuses a reorder that names the same state twice", async () => {
    const rows: StateRow[] = [{ id: 1, order: 0 }];
    const { db, store } = makeDb(rows);
    const service = makeService(db);

    const body: BulkReorderStatesInput = {
      items: [
        { stateId: 1, order: 0 },
        { stateId: 1, order: 1 },
      ],
    };

    await expect(
      service.bulkReorderCustomStates(makeUser(), PROJECT_ID, body),
    ).rejects.toThrow(BadRequestException);
    expect(store.statements).toBe(0);
  });

  it("throws NotFoundException when a stateId does not exist in the project", async () => {
    const rows: StateRow[] = [{ id: 1, order: 0 }];
    const { db } = makeDb(rows);
    const service = makeService(db);

    const body: BulkReorderStatesInput = { items: [{ stateId: 99, order: 0 }] };

    await expect(service.bulkReorderCustomStates(makeUser(), PROJECT_ID, body)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("returns 409 when expectedOrder does not match current order (stale version)", async () => {
    const rows: StateRow[] = [
      { id: 1, order: 2 },
      { id: 2, order: 3 },
    ];
    const { db } = makeDb(rows);
    const service = makeService(db);

    const body: BulkReorderStatesInput = {
      items: [
        { stateId: 1, order: 0, expectedOrder: 0 },
        { stateId: 2, order: 1, expectedOrder: 3 },
      ],
    };

    let thrown: unknown;
    try {
      await service.bulkReorderCustomStates(makeUser(), PROJECT_ID, body);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    const exc = thrown as HttpException;
    expect(exc.getStatus()).toBe(409);
    const body_ = exc.getResponse() as { error: string; conflicts: unknown[] };
    expect(body_.error).toBe("conflict");
    expect(body_.conflicts).toHaveLength(1);
    expect(body_.conflicts[0]).toMatchObject({ stateId: 1, currentOrder: 2, expectedOrder: 0 });
  });

  it("runs inside a single transaction — no partial updates on conflict", async () => {
    const rows: StateRow[] = [
      { id: 1, order: 5 },
      { id: 2, order: 6 },
    ];
    const { db, store } = makeDb(rows);
    const service = makeService(db);

    const body: BulkReorderStatesInput = {
      items: [
        { stateId: 1, order: 0, expectedOrder: 99 },
        { stateId: 2, order: 1, expectedOrder: 6 },
      ],
    };

    await expect(service.bulkReorderCustomStates(makeUser(), PROJECT_ID, body)).rejects.toThrow(
      HttpException,
    );

    expect(store.updateCalls).toBe(0);
    expect(store.statements).toBe(0);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("skips version check when expectedOrder is omitted, always updates", async () => {
    const rows: StateRow[] = [
      { id: 1, order: 7 },
      { id: 2, order: 8 },
    ];
    const { db } = makeDb(rows);
    const service = makeService(db);

    const body: BulkReorderStatesInput = {
      items: [
        { stateId: 1, order: 0 },
        { stateId: 2, order: 1 },
      ],
    };

    const { db: db2, store } = makeDb(rows);
    const service2 = makeService(db2);
    const result = await service2.bulkReorderCustomStates(makeUser(), PROJECT_ID, body);

    expect(result.items).toHaveLength(2);
    expect(store.statements).toBe(1);
  });

  it("is bounded at 50 items by the schema", () => {
    const tooMany = { items: Array.from({ length: 51 }, (_, i) => ({ stateId: i + 1, order: i })) };
    const result = bulkReorderStatesSchema.safeParse(tooMany);
    expect(result.success).toBe(false);
  });
});
