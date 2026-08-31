import { drizzle } from "drizzle-orm/postgres-js";
import { pgTable, integer, text } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createTenantAwareDb, type DbWithClient } from "../tenant-db";
import { TenantContextService, type TenantContext } from "../tenant-context";
import type { TenantTx } from "../with-tenant";

const testProjects = pgTable("test_proj", {
  id: integer("id").primaryKey(),
  orgId: text("org_id"),
});

const testMembers = pgTable("test_mem", {
  id: integer("id").primaryKey(),
  projectId: integer("project_id"),
});

const testProjectRelations = relations(testProjects, ({ many }) => ({
  members: many(testMembers),
}));

const testMemberRelations = relations(testMembers, ({ one }) => ({
  project: one(testProjects, {
    fields: [testMembers.projectId],
    references: [testProjects.id],
  }),
}));

const testSchema = { testProjects, testMembers, testProjectRelations, testMemberRelations };

type FakeClient = { end: jest.Mock };

type FakeTx = {
  execute: jest.Mock;
  select: jest.Mock;
  query: { someTable: { findFirst: jest.Mock } };
};

type FakeDb = {
  __client: FakeClient;
  select: jest.Mock;
  query: { someTable: { findFirst: jest.Mock } };
  transaction: jest.Mock;
};

type ProxySurface = {
  __client: FakeClient;
  select: jest.Mock;
  query: { someTable: { findFirst: jest.Mock } };
};

describe("createTenantAwareDb", () => {
  const service = new TenantContextService();
  let fakeClient: FakeClient;
  let fakeDb: FakeDb;
  let fakeTx: FakeTx;
  let proxy: ProxySurface;

  beforeEach(() => {
    fakeClient = { end: jest.fn() };
    fakeDb = {
      __client: fakeClient,
      select: jest.fn().mockReturnValue("db-result"),
      query: { someTable: { findFirst: jest.fn().mockReturnValue("db-find-first") } },
      transaction: jest.fn(),
    };
    fakeTx = {
      execute: jest.fn(),
      select: jest.fn().mockReturnValue("tx-result"),
      query: { someTable: { findFirst: jest.fn().mockReturnValue("tx-find-first") } },
    };
    proxy = createTenantAwareDb(fakeDb as unknown as DbWithClient) as unknown as ProxySurface;
  });

  it("routes to the underlying db when no tenant context is active", () => {
    proxy.select();

    expect(fakeDb.select).toHaveBeenCalledTimes(1);
    expect(fakeTx.select).not.toHaveBeenCalled();
  });

  it("routes to the ambient transaction when a context is active", async () => {
    const ctx: TenantContext = {
      orgId: "org-1",
      audience: "INTERNAL",
      tx: fakeTx as unknown as TenantTx,
    };

    await service.run(ctx, async () => {
      proxy.select();

      expect(fakeTx.select).toHaveBeenCalledTimes(1);
      expect(fakeDb.select).not.toHaveBeenCalled();
    });
  });

  it("always resolves __client to the real client even inside a context", async () => {
    const ctx: TenantContext = {
      orgId: "org-1",
      audience: "INTERNAL",
      tx: fakeTx as unknown as TenantTx,
    };

    await service.run(ctx, async () => {
      expect(proxy.__client).toBe(fakeClient);
    });
  });

  it("nested query access resolves from the transaction when a context is active", async () => {
    const ctx: TenantContext = {
      orgId: "org-1",
      audience: "INTERNAL",
      tx: fakeTx as unknown as TenantTx,
    };

    await service.run(ctx, async () => {
      const q = proxy.query;

      expect(q).toBe(fakeTx.query);
      expect(q.someTable.findFirst).toBe(fakeTx.query.someTable.findFirst);
    });
  });

  it("binds methods to the transaction so that `this` inside the method is the tx", async () => {
    const capturedReceiver: { value: object | undefined } = { value: undefined };
    const txWithCapture: FakeTx = {
      ...fakeTx,
      select: jest.fn().mockImplementation(function (this: object) {
        capturedReceiver.value = this;
      }),
    };
    const ctx: TenantContext = {
      orgId: "org-1",
      audience: "INTERNAL",
      tx: txWithCapture as unknown as TenantTx,
    };

    await service.run(ctx, async () => {
      proxy.select();

      expect(capturedReceiver.value).toBe(txWithCapture);
    });
  });
});

describe("relational query routing through real Drizzle internals", () => {
  const service = new TenantContextService();

  function buildTrackedClients() {
    const txUnsafe = jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue([]),
    });
    const poolUnsafe = jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue([]),
    });
    const txClient = { unsafe: txUnsafe };
    const poolClient = {
      unsafe: poolUnsafe,
      options: { parsers: {}, serializers: {} },
      begin: jest.fn().mockImplementation((fn: (c: typeof txClient) => unknown) => fn(txClient)),
    };
    return { txUnsafe, poolUnsafe, txClient, poolClient };
  }

  it("findFirst({ with: {...} }) calls txClient.unsafe when a tenant context is active", async () => {
    const { txUnsafe, poolUnsafe, poolClient } = buildTrackedClients();

    const db = drizzle(poolClient as never, { schema: testSchema });
    const proxy = createTenantAwareDb(
      Object.assign(db, { __client: poolClient }) as unknown as DbWithClient,
    );

    await (db as { session: { transaction: (fn: (tx: TenantTx) => Promise<void>) => Promise<void> } }).session.transaction(
      async (tx: TenantTx) => {
        await service.run({ orgId: "org-1", audience: "INTERNAL", tx }, async () => {
          txUnsafe.mockClear();
          poolUnsafe.mockClear();

          await (proxy as { query: { testProjects: { findFirst: (cfg: unknown) => Promise<unknown> } } }).query.testProjects.findFirst({
            with: { members: true },
          });

          expect(txUnsafe).toHaveBeenCalled();
          expect(poolUnsafe).not.toHaveBeenCalled();
        });
      },
    );
  });

  it("findFirst({ with: {...} }) calls poolClient.unsafe when bypassing the proxy (anti-test — proves the tracker bites)", async () => {
    const { txUnsafe, poolUnsafe, poolClient } = buildTrackedClients();

    const db = drizzle(poolClient as never, { schema: testSchema });

    await (db as { session: { transaction: (fn: (tx: TenantTx) => Promise<void>) => Promise<void> } }).session.transaction(
      async (_tx: TenantTx) => {
        poolUnsafe.mockClear();
        txUnsafe.mockClear();

        await (db as { query: { testProjects: { findFirst: (cfg: unknown) => Promise<unknown> } } }).query.testProjects.findFirst({
          with: { members: true },
        });

        expect(poolUnsafe).toHaveBeenCalled();
        expect(txUnsafe).not.toHaveBeenCalled();
      },
    );
  });
});
