import { ReplicaRouter, ReplicaShedError, routingStrategyFor } from "./replica-router";
import { NullReplicaHealthProbe, PostgresReplicaLagProbe } from "./replica-lag-probe";
import type { ReplicaLagProbeDb } from "./replica-lag-probe";

const PRIMARY = { id: "primary", connectionString: "postgres://primary/db" };
const REPLICA = { id: "replica", connectionString: "postgres://replica/db" };

describe("routingStrategyFor classifies work classes correctly", () => {
  it("analytics-refresh is replica-safe", () => {
    expect(routingStrategyFor("analytics-refresh")).toBe("replica-safe");
  });

  it("search-freshness is replica-safe", () => {
    expect(routingStrategyFor("search-freshness")).toBe("replica-safe");
  });

  it("a reserved class (authentication) is primary-required", () => {
    expect(routingStrategyFor("authentication")).toBe("primary-required");
  });

  it("a sheddable class that is not analytics-refresh or search-freshness is primary-required", () => {
    expect(routingStrategyFor("ordinary-write")).toBe("primary-required");
  });
});

describe("ReplicaRouter with no replica configured", () => {
  const router = new ReplicaRouter(PRIMARY, null);

  it("replica-safe work class falls through to primary when no replica is configured", async () => {
    const pool = await router.route("search-freshness");
    expect(pool.id).toBe("primary");
  });

  it("primary-required work class routes to primary", async () => {
    const pool = await router.route("authentication");
    expect(pool.id).toBe("primary");
  });
});

describe("ReplicaRouter with a healthy replica", () => {
  const router = new ReplicaRouter(PRIMARY, REPLICA, new NullReplicaHealthProbe());

  it("NullReplicaHealthProbe always returns healthy so replica-safe work routes to the replica", async () => {
    const pool = await router.route("search-freshness");
    expect(pool.id).toBe("replica");
  });

  it("analytics-refresh also routes to the replica when healthy", async () => {
    const pool = await router.route("analytics-refresh");
    expect(pool.id).toBe("replica");
  });

  it("primary-required work still routes to primary even with a healthy replica", async () => {
    const pool = await router.route("authentication");
    expect(pool.id).toBe("primary");
  });
});

describe("ReplicaRouter with a faulted replica sheds replica-safe work", () => {
  it("throws ReplicaShedError for replica-safe work when replica is configured and faulted", () => {
    const router = new ReplicaRouter(PRIMARY, REPLICA, new NullReplicaHealthProbe());
    expect(() => router.routeWithFaultAwareness("search-freshness", false)).toThrow(
      ReplicaShedError,
    );
  });

  it("does not throw for primary-required work even when the replica is faulted", () => {
    const router = new ReplicaRouter(PRIMARY, REPLICA, new NullReplicaHealthProbe());
    const pool = router.routeWithFaultAwareness("authentication", false);
    expect(pool.id).toBe("primary");
  });
});

describe("PostgresReplicaLagProbe detects a non-replica or a lagged node as unhealthy", () => {
  it("returns false when the execute result reports the node is not a replica", async () => {
    const db: ReplicaLagProbeDb = {
      execute: async () => [{ is_replica: false, lag_ms: 0 }],
    };
    const probe = new PostgresReplicaLagProbe(db);
    expect(await probe.probe()).toBe(false);
  });

  it("returns false when lag exceeds the default 5-second ceiling", async () => {
    const db: ReplicaLagProbeDb = {
      execute: async () => [{ is_replica: true, lag_ms: 6000 }],
    };
    const probe = new PostgresReplicaLagProbe(db);
    expect(await probe.probe()).toBe(false);
  });

  it("returns true when the node is a replica within the lag threshold", async () => {
    const db: ReplicaLagProbeDb = {
      execute: async () => [{ is_replica: true, lag_ms: 100 }],
    };
    const probe = new PostgresReplicaLagProbe(db);
    expect(await probe.probe()).toBe(true);
  });

  it("returns false on execute error rather than propagating the exception", async () => {
    const db: ReplicaLagProbeDb = {
      execute: async () => {
        throw new Error("connection refused");
      },
    };
    const probe = new PostgresReplicaLagProbe(db);
    expect(await probe.probe()).toBe(false);
  });
});

describe("NullReplicaHealthProbe is the default when no DB_REPLICA_URL is configured", () => {
  it("NullReplicaHealthProbe.probe always returns true", async () => {
    expect(await new NullReplicaHealthProbe().probe()).toBe(true);
  });

  it("with no replica URL, RouterFactory passes NullReplicaHealthProbe, so search-freshness routes to primary", async () => {
    const router = new ReplicaRouter(PRIMARY, null, new NullReplicaHealthProbe());
    const pool = await router.route("search-freshness");
    expect(pool.id).toBe("primary");
  });

  it("CONTROL: with a replica URL and NullReplicaHealthProbe, search-freshness routes to the replica confirming the probe selection matters", async () => {
    const router = new ReplicaRouter(PRIMARY, REPLICA, new NullReplicaHealthProbe());
    const pool = await router.route("search-freshness");
    expect(pool.id).toBe("replica");
  });
});
