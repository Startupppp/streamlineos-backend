import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { AiConfirmationService } from "./ai-confirmation.service";
import {
  boundedIdempotencyKey,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from "./ai-confirmation.helpers";

const dialect = new PgDialect();

process.env.AI_CONFIRMATION_SECRET = "test-secret-for-unit-tests-xxxxxxxxxxxxx";

type ProposalStatus = "PROPOSED" | "CONFIRMED" | "EXECUTED" | "EXPIRED" | "CANCELLED";

interface FakeRow {
  id: number;
  orgId: string;
  userId: string;
  action: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  status: ProposalStatus;
  idempotencyKey: string | null;
  expiresAt: Date;
  executedAt: Date | null;
  result: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeStore() {
  const rows = new Map<number, FakeRow>();
  let nextId = 1;
  return {
    rows,
    insert(vals: Omit<FakeRow, "id" | "createdAt" | "updatedAt"> & { idempotencyKey?: string | null }): FakeRow {
      const id = nextId++;
      const now = new Date();
      const row: FakeRow = {
        id,
        orgId: vals.orgId,
        userId: vals.userId,
        action: vals.action,
        payload: vals.payload,
        payloadHash: vals.payloadHash,
        status: vals.status ?? "PROPOSED",
        idempotencyKey: vals.idempotencyKey ?? null,
        expiresAt: vals.expiresAt,
        executedAt: null,
        result: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(id, row);
      return row;
    },
    findById(id: number): FakeRow | undefined {
      return rows.get(id);
    },
    findByIdempotencyKey(orgId: string, key: string): FakeRow | undefined {
      return Array.from(rows.values()).find(
        (r) => r.orgId === orgId && r.idempotencyKey === key,
      );
    },
    patch(id: number, patch: Partial<FakeRow>): FakeRow[] {
      const row = rows.get(id);
      if (!row) return [];
      const next = { ...row, ...patch };
      rows.set(id, next);
      return [next];
    },
    patchWhere(pred: (r: FakeRow) => boolean, patch: Partial<FakeRow>): FakeRow[] {
      const updated: FakeRow[] = [];
      for (const [id, row] of rows) {
        if (pred(row)) {
          const next = { ...row, ...patch };
          rows.set(id, next);
          updated.push(next);
        }
      }
      return updated;
    },
  };
}

function makeFakeDb(store: ReturnType<typeof makeStore>) {
  const noopChain = {
    where: () => noopChain,
    for: () => noopChain,
    limit: () => noopChain,
    then: undefined as unknown,
  };

  function _selectChain(resultFn: () => FakeRow[]): unknown {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.for = () => chain;
    chain.limit = () => chain;
    chain.then = (resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) =>
      Promise.resolve(resultFn()).then(resolve, reject);
    return chain;
  }

  function _updateChain(resultFn: () => FakeRow[], returnFn?: () => Array<{ id: number }>): unknown {
    const chain: Record<string, unknown> = {};
    chain.where = () => chain;
    chain.then = (resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) =>
      Promise.resolve(resultFn()).then(resolve, reject);
    chain.returning = () => Promise.resolve(returnFn ? returnFn() : resultFn().map((r) => ({ id: r.id })));
    return chain;
  }

  const _pendingInsert: Omit<FakeRow, "id" | "createdAt" | "updatedAt"> & { idempotencyKey?: string | null } | null = null;
  let _pendingPatch: Partial<FakeRow> | null = null;
  let _selectId: number | null = null;

  const db: Record<string, unknown> = {
    select: () => ({
      from: () => ({
        where: (_cond: unknown) => ({
          for: (_mode: unknown) => ({
            limit: (n: number) => {
              return {
                then: (resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) => {
                  const id = _selectId;
                  _selectId = null;
                  const result = id !== null ? (store.findById(id) ? [store.findById(id)!] : []) : [];
                  return Promise.resolve(result.slice(0, n)).then(resolve, reject);
                },
              };
            },
          }),
          limit: (n: number) => {
            return {
              then: (resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) => {
                const id = _selectId;
                _selectId = null;
                const result = id !== null ? (store.findById(id) ? [store.findById(id)!] : []) : [];
                return Promise.resolve(result.slice(0, n)).then(resolve, reject);
              },
            };
          },
        }),
      }),
    }),

    insert: (_table: unknown) => ({
      values: (vals: Omit<FakeRow, "id" | "createdAt" | "updatedAt"> & { idempotencyKey?: string | null }) => ({
        returning: () => {
          const row = store.insert(vals);
          return Promise.resolve([row]);
        },
      }),
    }),

    update: (_table: unknown) => ({
      set: (patch: Partial<FakeRow>) => ({
        where: (_cond: unknown) => {
          _pendingPatch = patch;
          return {
            then: (resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) =>
              Promise.resolve([]).then(resolve, reject),
            returning: () => {
              const result = _pendingPatch
                ? store.patchWhere(() => true, _pendingPatch!)
                : [];
              _pendingPatch = null;
              return Promise.resolve(result.map((r) => ({ id: r.id })));
            },
          };
        },
      }),
    }),

    execute: jest.fn().mockResolvedValue([]),

    transaction: async <T>(cb: (tx: Record<string, unknown>) => Promise<T>): Promise<T> => cb(db),
  };

  return { db, setSelectId: (id: number) => { _selectId = id; } };
}

describe("AiConfirmationService — isolated unit tests", () => {
  function setup() {
    const store = makeStore();

    const auditMock = { log: jest.fn() };

    async function _proposeAndGetRow(
      opts: Partial<Parameters<AiConfirmationService["propose"]>[0]> = {},
    ) {
      const input = {
        orgId: "org1",
        userId: "user1",
        action: "test_action",
        payload: { key: "val" },
        ...opts,
      };
      const result = await svc.propose(input);
      const row = store.rows.get(result.proposalId);
      return { result, row };
    }

    const fakeDb = makeFakeDb(store);

    const svc = new AiConfirmationService(
      new Proxy(fakeDb.db, {
        get(target, prop) {
          if (prop === "select") {
            return (_table?: unknown) => ({
              from: (_t?: unknown) => ({
                where: (_cond: unknown) => ({
                  for: (_mode: unknown) => ({
                    limit: (n: number) => ({
                      then(
                        resolve: (v: FakeRow[]) => void,
                        reject: (e: unknown) => void,
                      ) {
                        const all = Array.from(store.rows.values());
                        return Promise.resolve(all.slice(0, n)).then(resolve, reject);
                      },
                    }),
                  }),
                  limit: (n: number) => ({
                    then(
                      resolve: (v: FakeRow[]) => void,
                      reject: (e: unknown) => void,
                    ) {
                      const all = Array.from(store.rows.values());
                      return Promise.resolve(all.slice(0, n)).then(resolve, reject);
                    },
                  }),
                }),
              }),
            });
          }
          return (target as Record<string | symbol, unknown>)[prop];
        },
      }) as never,
      auditMock as never,
    );

    return { svc, store, auditMock };
  }

  it("propose returns a well-formed token", async () => {
    const { svc, store } = setup();
    const result = await svc.propose({ orgId: "org1", userId: "u1", action: "act", payload: { x: 1 } });
    expect(result.proposalId).toBeGreaterThan(0);
    expect(result.token).toMatch(/^\d+\.\d+\.[a-f0-9]{64}$/);
    expect(store.rows.get(result.proposalId)?.status).toBe("PROPOSED");
  });

  it("propose -> confirm happy path resolves payload", async () => {
    const { svc, store } = setup();

    const proposed = await svc.propose({
      orgId: "org1",
      userId: "user1",
      action: "delete_record",
      payload: { recordId: "abc" },
    });

    const row = store.rows.get(proposed.proposalId);
    expect(row).toBeDefined();

    const overrideSelect = new Proxy({} as never, {
      get(_t, prop) {
        if (prop === "select") {
          return () => ({
            from: () => ({
              where: () => ({
                for: () => ({
                  limit: (n: number) => ({
                    then(resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) {
                      return Promise.resolve([row!].slice(0, n)).then(resolve, reject);
                    },
                  }),
                }),
                limit: (n: number) => ({
                  then(resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) {
                    return Promise.resolve([row!].slice(0, n)).then(resolve, reject);
                  },
                }),
              }),
            }),
          });
        }
        if (prop === "update") {
          return () => ({
            set: (patch: Partial<FakeRow>) => ({
              where: () => {
                const id = proposed.proposalId;
                const current = store.rows.get(id);
                if (current) store.rows.set(id, { ...current, ...patch });
                return {
                  then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
                    return Promise.resolve([]).then(resolve, reject);
                  },
                  returning: () => Promise.resolve([{ id }]),
                };
              },
            }),
          });
        }
        if (prop === "transaction") {
          return async <T>(cb: (tx: unknown) => Promise<T>) => cb(overrideSelect);
        }
        if (prop === "execute") return jest.fn().mockResolvedValue([]);
        return undefined;
      },
    });

    const svc2 = new AiConfirmationService(overrideSelect, { log: jest.fn() } as never);
    const confirmed = await svc2.confirm({
      token: proposed.token,
      actor: { orgId: "org1", userId: "user1" },
    });

    expect(confirmed.proposalId).toBe(proposed.proposalId);
    expect(confirmed.action).toBe("delete_record");
    expect(confirmed.payload).toEqual({ recordId: "abc" });
    expect(store.rows.get(proposed.proposalId)?.status).toBe("CONFIRMED");
  });

  it("tampered hmac throws ForbiddenException", async () => {
    const { svc, store } = setup();

    const proposed = await svc.propose({
      orgId: "org1",
      userId: "user1",
      action: "send_email",
      payload: { to: "x@y.com" },
    });

    const row = store.rows.get(proposed.proposalId);
    const parts = proposed.token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -4)}zzzz`;

    const confirmDb = new Proxy({} as never, {
      get(_t, prop) {
        if (prop === "transaction") {
          return async <T>(cb: (tx: unknown) => Promise<T>) => cb(confirmDb);
        }
        if (prop === "select") {
          return () => ({
            from: () => ({
              where: () => ({
                for: () => ({
                  limit: (n: number) => ({
                    then(resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) {
                      return Promise.resolve([row!].slice(0, n)).then(resolve, reject);
                    },
                  }),
                }),
              }),
            }),
          });
        }
        if (prop === "update") {
          return () => ({
            set: (patch: Partial<FakeRow>) => ({
              where: () => {
                const id = proposed.proposalId;
                const current = store.rows.get(id);
                if (current) store.rows.set(id, { ...current, ...patch });
                return {
                  then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
                    return Promise.resolve([]).then(resolve, reject);
                  },
                  returning: () => Promise.resolve([{ id }]),
                };
              },
            }),
          });
        }
        if (prop === "execute") return jest.fn().mockResolvedValue([]);
        return undefined;
      },
    });

    const svc2 = new AiConfirmationService(confirmDb, { log: jest.fn() } as never);
    await expect(
      svc2.confirm({ token: tampered, actor: { orgId: "org1", userId: "user1" } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("expired proposal throws BadRequestException and sets status EXPIRED", async () => {
    const { svc, store } = setup();

    const proposed = await svc.propose({
      orgId: "org1",
      userId: "user1",
      action: "archive",
      payload: { id: 99 },
      ttlSeconds: 1,
    });

    const row = store.rows.get(proposed.proposalId);
    if (row) store.rows.set(proposed.proposalId, { ...row, expiresAt: new Date(Date.now() - 5000) });
    const expiredRow = store.rows.get(proposed.proposalId)!;

    const expiredDb = new Proxy({} as never, {
      get(_t, prop) {
        if (prop === "transaction") {
          return async <T>(cb: (tx: unknown) => Promise<T>) => cb(expiredDb);
        }
        if (prop === "select") {
          return () => ({
            from: () => ({
              where: () => ({
                for: () => ({
                  limit: (n: number) => ({
                    then(resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) {
                      return Promise.resolve([expiredRow].slice(0, n)).then(resolve, reject);
                    },
                  }),
                }),
              }),
            }),
          });
        }
        if (prop === "update") {
          return () => ({
            set: (patch: Partial<FakeRow>) => ({
              where: () => {
                const id = proposed.proposalId;
                const current = store.rows.get(id);
                if (current) store.rows.set(id, { ...current, ...patch });
                return {
                  then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
                    return Promise.resolve([]).then(resolve, reject);
                  },
                  returning: () => Promise.resolve([{ id }]),
                };
              },
            }),
          });
        }
        if (prop === "execute") return jest.fn().mockResolvedValue([]);
        return undefined;
      },
    });

    const svc2 = new AiConfirmationService(expiredDb, { log: jest.fn() } as never);
    await expect(
      svc2.confirm({ token: proposed.token, actor: { orgId: "org1", userId: "user1" } }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(store.rows.get(proposed.proposalId)?.status).toBe("EXPIRED");
  });

  it("wrong actor orgId throws ForbiddenException", async () => {
    const { svc, store } = setup();
    const proposed = await svc.propose({ orgId: "org1", userId: "user1", action: "transfer", payload: {} });
    const row = store.rows.get(proposed.proposalId)!;

    const db = buildConfirmDb(row, store, proposed.proposalId);
    const svc2 = new AiConfirmationService(db, { log: jest.fn() } as never);

    await expect(
      svc2.confirm({ token: proposed.token, actor: { orgId: "org-WRONG", userId: "user1" } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("wrong actor userId throws ForbiddenException", async () => {
    const { svc, store } = setup();
    const proposed = await svc.propose({ orgId: "org1", userId: "user1", action: "purge", payload: { target: "all" } });
    const row = store.rows.get(proposed.proposalId)!;

    const db = buildConfirmDb(row, store, proposed.proposalId);
    const svc2 = new AiConfirmationService(db, { log: jest.fn() } as never);

    await expect(
      svc2.confirm({ token: proposed.token, actor: { orgId: "org1", userId: "user-WRONG" } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("double confirm throws ConflictException on second call", async () => {
    const { svc, store } = setup();
    const proposed = await svc.propose({ orgId: "org1", userId: "user1", action: "bulk_delete", payload: { ids: [1] } });
    const row = store.rows.get(proposed.proposalId)!;

    const db1 = buildConfirmDb(row, store, proposed.proposalId);
    const svc2 = new AiConfirmationService(db1, { log: jest.fn() } as never);
    await svc2.confirm({ token: proposed.token, actor: { orgId: "org1", userId: "user1" } });

    const updatedRow = store.rows.get(proposed.proposalId)!;
    const db2 = buildConfirmDb(updatedRow, store, proposed.proposalId);
    const svc3 = new AiConfirmationService(db2, { log: jest.fn() } as never);
    await expect(
      svc3.confirm({ token: proposed.token, actor: { orgId: "org1", userId: "user1" } }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("markExecuted is idempotent — second call returns without error", async () => {
    const { svc, store } = setup();
    const proposed = await svc.propose({ orgId: "org1", userId: "user1", action: "export", payload: { format: "csv" } });
    const row = store.rows.get(proposed.proposalId)!;

    const confirmDb = buildConfirmDb(row, store, proposed.proposalId);
    const svc2 = new AiConfirmationService(confirmDb, { log: jest.fn() } as never);
    await svc2.confirm({ token: proposed.token, actor: { orgId: "org1", userId: "user1" } });

    const confirmedRow = store.rows.get(proposed.proposalId)!;
    const execDb = buildSimpleSelectDb(confirmedRow, store, proposed.proposalId);
    const svc3 = new AiConfirmationService(execDb, { log: jest.fn() } as never);

    await svc3.markExecuted(proposed.proposalId, { exportedRows: 42 }, "org1");
    await expect(svc3.markExecuted(proposed.proposalId, { exportedRows: 42 }, "org1")).resolves.toBeUndefined();
    expect(store.rows.get(proposed.proposalId)?.status).toBe("EXECUTED");
  });

  it("sweepExpired returns count of rows marked EXPIRED", async () => {
    const { svc, store } = setup();
    await svc.propose({ orgId: "org1", userId: "u1", action: "a1", payload: {} });
    await svc.propose({ orgId: "org1", userId: "u1", action: "a2", payload: {} });

    const r1 = store.rows.get(1);
    const r2 = store.rows.get(2);
    if (r1) store.rows.set(1, { ...r1, expiresAt: new Date(Date.now() - 10000) });
    if (r2) store.rows.set(2, { ...r2, expiresAt: new Date(Date.now() - 10000) });

    const sweepDb = buildSweepDb(store);
    const svc2 = new AiConfirmationService(sweepDb, { log: jest.fn() } as never);
    const count = await svc2.sweepExpired();

    expect(count).toBe(2);
    expect(store.rows.get(1)?.status).toBe("EXPIRED");
    expect(store.rows.get(2)?.status).toBe("EXPIRED");
  });
});

function buildConfirmDb(
  row: FakeRow,
  store: ReturnType<typeof makeStore>,
  proposalId: number,
): never {
  const db: Record<string, unknown> = {};

  db.select = () => ({
    from: () => ({
      where: () => ({
        for: () => ({
          limit: (n: number) => ({
            then(resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) {
              const current = store.rows.get(proposalId) ?? row;
              return Promise.resolve([current].slice(0, n)).then(resolve, reject);
            },
          }),
        }),
      }),
    }),
  });

  db.update = () => ({
    set: (patch: Partial<FakeRow>) => ({
      where: () => {
        const current = store.rows.get(proposalId);
        if (current) store.rows.set(proposalId, { ...current, ...patch });
        return {
          then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
            return Promise.resolve([]).then(resolve, reject);
          },
          returning: () => Promise.resolve([{ id: proposalId }]),
        };
      },
    }),
  });

  db.execute = jest.fn().mockResolvedValue([]);
  db.transaction = async <T>(cb: (tx: typeof db) => Promise<T>): Promise<T> => cb(db);

  return db as never;
}

function buildSimpleSelectDb(
  row: FakeRow,
  store: ReturnType<typeof makeStore>,
  proposalId: number,
): never {
  const db: Record<string, unknown> = {};

  db.select = () => ({
    from: () => ({
      where: () => ({
        limit: (n: number) => ({
          then(resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) {
            const current = store.rows.get(proposalId) ?? row;
            return Promise.resolve([current].slice(0, n)).then(resolve, reject);
          },
        }),
      }),
    }),
  });

  db.update = () => ({
    set: (patch: Partial<FakeRow>) => ({
      where: () => {
        const current = store.rows.get(proposalId);
        if (current) store.rows.set(proposalId, { ...current, ...patch });
        return {
          then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
            return Promise.resolve([]).then(resolve, reject);
          },
          returning: () => Promise.resolve([{ id: proposalId }]),
        };
      },
    }),
  });

  db.execute = jest.fn().mockResolvedValue([]);
  db.transaction = async <T>(cb: (tx: typeof db) => Promise<T>): Promise<T> => cb(db);

  return db as never;
}

function buildSweepDb(store: ReturnType<typeof makeStore>): never {
  const db: Record<string, unknown> = {};

  db.update = () => ({
    set: (patch: Partial<FakeRow>) => ({
      where: () => {
        const updated = store.patchWhere(
          (r) => r.status === "PROPOSED" && r.expiresAt < new Date(),
          patch,
        );
        return {
          then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
            return Promise.resolve([]).then(resolve, reject);
          },
          returning: () => Promise.resolve(updated.map((r) => ({ id: r.id }))),
        };
      },
    }),
  });

  db.execute = jest.fn().mockResolvedValue([]);
  db.transaction = async <T>(cb: (tx: typeof db) => Promise<T>): Promise<T> => cb(db);

  return db as never;
}

function buildEmptySelectConfirmDb(): never {
  const db: Record<string, unknown> = {};

  db.select = () => ({
    from: () => ({
      where: () => ({
        for: () => ({
          limit: (n: number) => ({
            then(resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) {
              return Promise.resolve([].slice(0, n)).then(resolve, reject);
            },
          }),
        }),
      }),
    }),
  });

  db.update = () => ({
    set: () => ({
      where: () => ({
        then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
          return Promise.resolve([]).then(resolve, reject);
        },
        returning: () => Promise.resolve([]),
      }),
    }),
  });

  db.execute = jest.fn().mockResolvedValue([]);
  db.transaction = async <T>(cb: (tx: typeof db) => Promise<T>): Promise<T> => cb(db);

  return db as never;
}

describe("AiConfirmationService — ORACLE-1 existence oracle fix", () => {
  it("absent row returns NotFoundException (not ForbiddenException)", async () => {
    const emptyDb = buildEmptySelectConfirmDb();
    const svc = new AiConfirmationService(emptyDb, { log: jest.fn() } as never);

    const fakeToken = "999.9999999999.aabbccdd0011223344556677889900aabbccdd0011223344556677889900aabb";
    const err = await svc.confirm({ token: fakeToken, actor: { orgId: "org1", userId: "u1" } }).catch((e) => e);

    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).not.toMatch(/forbidden|access|exist|found.*another|tenant/i);
  });

  it("proof — bypassing the orgId filter exposes the oracle: a cross-tenant hit returns ForbiddenException (actor mismatch)", async () => {
    const store = makeStore();
    const auditMock = { log: jest.fn() };

    const fakeDb = makeFakeDb(store);
    const svc = new AiConfirmationService(
      new Proxy(fakeDb.db, {
        get(target, prop) {
          if (prop === "select") {
            return (_table?: unknown) => ({
              from: (_t?: unknown) => ({
                where: (_cond: unknown) => ({
                  for: (_mode: unknown) => ({
                    limit: (n: number) => ({
                      then(
                        resolve: (v: FakeRow[]) => void,
                        reject: (e: unknown) => void,
                      ) {
                        const all = Array.from(store.rows.values());
                        return Promise.resolve(all.slice(0, n)).then(resolve, reject);
                      },
                    }),
                  }),
                }),
              }),
            });
          }
          return (target as Record<string | symbol, unknown>)[prop];
        },
      }) as never,
      auditMock as never,
    );

    const proposed = await svc.propose({ orgId: "org1", userId: "user1", action: "delete", payload: {} });
    const row = store.rows.get(proposed.proposalId)!;

    const bypassDb = buildConfirmDb(row, store, proposed.proposalId);
    const svc2 = new AiConfirmationService(bypassDb, { log: jest.fn() } as never);

    const err = await svc2.confirm({
      token: proposed.token,
      actor: { orgId: "org-ATTACKER", userId: "user1" },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it("cross-tenant probe with filtered db returns NotFoundException (no oracle)", async () => {
    const store = makeStore();
    const auditMock = { log: jest.fn() };

    const fakeDb = makeFakeDb(store);
    const svc = new AiConfirmationService(
      new Proxy(fakeDb.db, {
        get(target, prop) {
          if (prop === "select") {
            return (_table?: unknown) => ({
              from: (_t?: unknown) => ({
                where: (_cond: unknown) => ({
                  for: (_mode: unknown) => ({
                    limit: (n: number) => ({
                      then(
                        resolve: (v: FakeRow[]) => void,
                        reject: (e: unknown) => void,
                      ) {
                        const all = Array.from(store.rows.values());
                        return Promise.resolve(all.slice(0, n)).then(resolve, reject);
                      },
                    }),
                  }),
                }),
              }),
            });
          }
          return (target as Record<string | symbol, unknown>)[prop];
        },
      }) as never,
      auditMock as never,
    );

    const proposed = await svc.propose({ orgId: "org1", userId: "user1", action: "delete", payload: {} });

    const emptyDb = buildEmptySelectConfirmDb();
    const svc2 = new AiConfirmationService(emptyDb, { log: jest.fn() } as never);

    const err = await svc2.confirm({
      token: proposed.token,
      actor: { orgId: "org-ATTACKER", userId: "user1" },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(NotFoundException);
  });

  it("confirm WHERE predicate includes caller orgId — removing eq(orgId) changes the compiled predicate", async () => {
    const proposeStore = makeStore();
    const proposeDbHandle = makeFakeDb(proposeStore);
    const proposeSvc = new AiConfirmationService(
      proposeDbHandle.db as never,
      { log: jest.fn() } as never,
    );
    const proposed = await proposeSvc.propose({
      orgId: "org-victim",
      userId: "u1",
      action: "delete",
      payload: {},
    });

    let capturedCondition: unknown;
    const captureDb: Record<string, unknown> = {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            capturedCondition = condition;
            return {
              for: () => ({
                limit: (n: number) => ({
                  then(resolve: (v: FakeRow[]) => void, reject: (e: unknown) => void) {
                    return Promise.resolve([].slice(0, n)).then(resolve, reject);
                  },
                }),
              }),
            };
          },
        }),
      }),
      execute: jest.fn().mockResolvedValue([]),
      transaction: async <T>(cb: (tx: Record<string, unknown>) => Promise<T>): Promise<T> => cb(captureDb),
    };

    const svc2 = new AiConfirmationService(captureDb as never, { log: jest.fn() } as never);
    await svc2
      .confirm({ token: proposed.token, actor: { orgId: "org-ATTACKER", userId: "u1" } })
      .catch(() => {});

    expect(capturedCondition).toBeDefined();
    const { sql: compiledSql, params } = dialect.sqlToQuery(capturedCondition as SQL);
    expect(compiledSql).toMatch(/org_id/);
    expect(params).toContain("org-ATTACKER");
  });
});
describe("a long idempotency key is bounded to the column width before it reaches Postgres", () => {
  it("passes a key that already fits through untouched, so existing keys keep matching", () => {
    const key = `${"a".repeat(60)}:${"b".repeat(59)}`;

    expect(key).toHaveLength(MAX_IDEMPOTENCY_KEY_LENGTH);
    expect(boundedIdempotencyKey(key)).toBe(key);
  });

  it("digests a key wider than the column, because Ask OS builds 125-character keys that fail 22001", () => {
    const orgId = "871a5fd2-df81-4e79-a097-9910d6640a01";
    const userId = "3a99283a-40be-4758-953b-458548e064fa";
    const key = `${orgId}:${userId}:self.applyLeave:2026-09-19:16:2026-12-24:2026-12-24`;

    expect(key.length).toBeGreaterThan(MAX_IDEMPOTENCY_KEY_LENGTH);
    expect(boundedIdempotencyKey(key)).toHaveLength(64);
    expect(boundedIdempotencyKey(key).length).toBeLessThanOrEqual(MAX_IDEMPOTENCY_KEY_LENGTH);
  });

  it("is deterministic, so a retry of the same action still finds the first proposal", () => {
    const key = `${"z".repeat(200)}`;

    expect(boundedIdempotencyKey(key)).toBe(boundedIdempotencyKey(key));
  });

  it("separates two distinct over-long keys, so two different actions never share a proposal", () => {
    const base = `${"q".repeat(130)}`;

    expect(boundedIdempotencyKey(`${base}:a`)).not.toBe(boundedIdempotencyKey(`${base}:b`));
  });
});
