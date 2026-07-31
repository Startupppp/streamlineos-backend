import { createTenantAwareDb, type DbWithClient } from "../tenant-db";
import { TenantContextService, type TenantContext } from "../tenant-context";
import type { TenantTx } from "../with-tenant";

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
