import { routedRead, ReplicaShedError } from "../routed-read";
import { ReplicaRouter } from "../replica-router";
import { NullReplicaHealthProbe } from "../replica-lag-probe";
import { runWithTenantContext } from "../../common/tenant/tenant-context";
import type { TenantContext } from "../../common/tenant/tenant-context";
import type { Db } from "../drizzle.types";

const PRIMARY_HANDLE = { id: "primary", connectionString: "postgres://primary/db" };
const REPLICA_HANDLE = { id: "replica", connectionString: "postgres://replica/db" };

const primaryDb = { __brand: "primary" } as unknown as Db;
const replicaDb = { __brand: "replica" } as unknown as Db;

const MOCK_TENANT_CONTEXT: TenantContext = {
  orgId: "org-test",
  audience: "INTERNAL",
  tx: {} as TenantContext["tx"],
};

describe("routedRead — unclassified reads default to primary regardless of replica health", () => {
  it("a primary-required work class routes to primary even when the replica is healthy", async () => {
    const router = new ReplicaRouter(PRIMARY_HANDLE, REPLICA_HANDLE, new NullReplicaHealthProbe());

    let received: Db | undefined;
    await routedRead("authentication", primaryDb, replicaDb, router, (db) => {
      received = db;
      return Promise.resolve(undefined);
    });

    expect(received).toBe(primaryDb);
  });

  it("a sheddable but not replica-safe work class routes to primary even when the replica is healthy", async () => {
    const router = new ReplicaRouter(PRIMARY_HANDLE, REPLICA_HANDLE, new NullReplicaHealthProbe());

    let received: Db | undefined;
    await routedRead("ordinary-write", primaryDb, replicaDb, router, (db) => {
      received = db;
      return Promise.resolve(undefined);
    });

    expect(received).toBe(primaryDb);
  });

  it("CONTROL: replica-safe work class outside a transaction uses the replica when healthy, proving the primary guards are not vacuous", async () => {
    const router = new ReplicaRouter(PRIMARY_HANDLE, REPLICA_HANDLE, new NullReplicaHealthProbe());

    let received: Db | undefined;
    await routedRead("search-freshness", primaryDb, replicaDb, router, (db) => {
      received = db;
      return Promise.resolve(undefined);
    });

    expect(received).toBe(replicaDb);
  });
});

describe("routedRead — anything inside a tenant transaction stays on the primary", () => {
  it("a replica-safe read inside a tenant transaction uses primary to remain within the transaction boundary", async () => {
    const router = new ReplicaRouter(PRIMARY_HANDLE, REPLICA_HANDLE, new NullReplicaHealthProbe());

    let received: Db | undefined;
    await runWithTenantContext(MOCK_TENANT_CONTEXT, async () => {
      await routedRead("search-freshness", primaryDb, replicaDb, router, (db) => {
        received = db;
        return Promise.resolve(undefined);
      });
    });

    expect(received).toBe(primaryDb);
  });

  it("an analytics-refresh read inside a tenant transaction stays on primary even though analytics-refresh is replica-safe", async () => {
    const router = new ReplicaRouter(PRIMARY_HANDLE, REPLICA_HANDLE, new NullReplicaHealthProbe());

    let received: Db | undefined;
    await runWithTenantContext(MOCK_TENANT_CONTEXT, async () => {
      await routedRead("analytics-refresh", primaryDb, replicaDb, router, (db) => {
        received = db;
        return Promise.resolve(undefined);
      });
    });

    expect(received).toBe(primaryDb);
  });
});

describe("routedRead — with no replica configured, replica-safe reads fall through to primary", () => {
  it("no replica configured means search-freshness routes to primary", async () => {
    const router = new ReplicaRouter(PRIMARY_HANDLE, null, new NullReplicaHealthProbe());

    let received: Db | undefined;
    await routedRead("search-freshness", primaryDb, replicaDb, router, (db) => {
      received = db;
      return Promise.resolve(undefined);
    });

    expect(received).toBe(primaryDb);
  });
});

describe("routedRead — faulted replica sheds rather than silently falling back", () => {
  it("when the replica is configured but faulted, routedRead propagates ReplicaShedError to protect primary capacity", async () => {
    const faultedProbe = { probe: async (): Promise<boolean> => false };
    const router = new ReplicaRouter(PRIMARY_HANDLE, REPLICA_HANDLE, faultedProbe);

    await expect(
      routedRead("search-freshness", primaryDb, replicaDb, router, () => Promise.resolve(undefined)),
    ).rejects.toBeInstanceOf(ReplicaShedError);
  });
});
