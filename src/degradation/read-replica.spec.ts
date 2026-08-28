import { poolEnvShape, resolvePoolConfig } from "../db/pool.config";
import { shedRank, isReserved } from "../common/admission/work-class";
import {
  ReplicaRouter,
  ReplicaShedError,
  routingStrategyFor,
} from "../db/replica-router";

describe("Read replica degraded — correctness-sensitive reads go to primary", () => {
  describe("single-connection ratchet: replica env var and routing seam were added together", () => {
    it(
      "poolEnvShape declares DB_REPLICA_URL — the routing seam (ReplicaRouter) was built at the same time, " +
        "so a half-built replica cannot ship: adding the env var alone makes the routing tests go red",
      () => {
        const replicaKeys = Object.keys(poolEnvShape).filter((k) => /REPLICA/i.test(k));
        expect(replicaKeys).toContain("DB_REPLICA_URL");
      },
    );

    it(
      "resolvePoolConfig returns an optional replicaConnectionString alongside connectionString — " +
        "undefined when DB_REPLICA_URL is absent, a normalized URL when it is present",
      () => {
        const noReplica = resolvePoolConfig({
          APP_DATABASE_URL: "postgres://user:pass@localhost/db",
        });
        expect(typeof noReplica.connectionString).toBe("string");
        expect("replicaConnectionString" in noReplica).toBe(true);
        expect(noReplica.replicaConnectionString).toBeUndefined();

        const withReplica = resolvePoolConfig({
          APP_DATABASE_URL: "postgres://user:pass@localhost/db",
          DB_REPLICA_URL: "postgres://user:pass@replica.example.com/db",
        });
        expect(typeof withReplica.replicaConnectionString).toBe("string");
        expect(withReplica.replicaConnectionString).toContain("replica.example.com");
      },
    );
  });

  describe("stale-tolerant projections shed before ordinary writes when the primary is under load", () => {
    it("analytics-refresh is sheddable — it does not hold primary capacity", () => {
      expect(isReserved("analytics-refresh")).toBe(false);
    });

    it("search-freshness is sheddable — it does not hold primary capacity", () => {
      expect(isReserved("search-freshness")).toBe(false);
    });

    it("analytics-refresh sheds before ordinary-write", () => {
      expect(shedRank("analytics-refresh")).toBeLessThan(shedRank("ordinary-write"));
    });

    it("search-freshness sheds before ordinary-write", () => {
      expect(shedRank("search-freshness")).toBeLessThan(shedRank("ordinary-write"));
    });
  });

  describe("routing strategy — which work classes are replica-safe vs primary-required", () => {
    it("RBAC and authentication classes are primary-required", () => {
      expect(routingStrategyFor("authentication")).toBe("primary-required");
      expect(routingStrategyFor("authorization-revocation")).toBe("primary-required");
      expect(routingStrategyFor("ownership")).toBe("primary-required");
    });

    it("financial-ledger and audit classes are primary-required", () => {
      expect(routingStrategyFor("billing-ledger")).toBe("primary-required");
      expect(routingStrategyFor("payroll-posting")).toBe("primary-required");
      expect(routingStrategyFor("audit")).toBe("primary-required");
      expect(routingStrategyFor("mandatory-security-delivery")).toBe("primary-required");
    });

    it("analytics-refresh is replica-safe — it produces an eventually-consistent projection", () => {
      expect(routingStrategyFor("analytics-refresh")).toBe("replica-safe");
    });

    it("search-freshness is replica-safe — it populates a search index, not a user-visible answer", () => {
      expect(routingStrategyFor("search-freshness")).toBe("replica-safe");
    });

    it("ordinary-write and other sheddable classes are primary-required despite being sheddable", () => {
      expect(routingStrategyFor("ordinary-write")).toBe("primary-required");
      expect(routingStrategyFor("prefetch")).toBe("primary-required");
      expect(routingStrategyFor("ai-enrichment")).toBe("primary-required");
      expect(routingStrategyFor("non-mandatory-notification")).toBe("primary-required");
    });
  });

  describe("ReplicaRouter routing decisions (observable via PoolHandle.id)", () => {
    const primary: { id: string; connectionString: string } = {
      id: "primary",
      connectionString: "postgres://primary",
    };
    const replica: { id: string; connectionString: string } = {
      id: "replica",
      connectionString: "postgres://replica",
    };

    it("routes primary-required classes to primary even when a healthy replica is configured", () => {
      const router = new ReplicaRouter(primary, replica);
      expect(router.routeWithFaultAwareness("authentication", true).id).toBe("primary");
      expect(router.routeWithFaultAwareness("authorization-revocation", true).id).toBe("primary");
      expect(router.routeWithFaultAwareness("billing-ledger", true).id).toBe("primary");
      expect(router.routeWithFaultAwareness("payroll-posting", true).id).toBe("primary");
      expect(router.routeWithFaultAwareness("audit", true).id).toBe("primary");
      expect(router.routeWithFaultAwareness("ordinary-write", true).id).toBe("primary");
    });

    it("routes analytics-refresh to the replica when the replica is configured and healthy", () => {
      const router = new ReplicaRouter(primary, replica);
      expect(router.routeWithFaultAwareness("analytics-refresh", true).id).toBe("replica");
    });

    it("routes search-freshness to the replica when the replica is configured and healthy", () => {
      const router = new ReplicaRouter(primary, replica);
      expect(router.routeWithFaultAwareness("search-freshness", true).id).toBe("replica");
    });

    it(
      "sheds analytics-refresh rather than silently falling back to primary when the replica is configured but faulted — " +
        "a silent fall-back would allow stale projections to compete for primary capacity",
      () => {
        const router = new ReplicaRouter(primary, replica);
        expect(() => router.routeWithFaultAwareness("analytics-refresh", false)).toThrow(
          ReplicaShedError,
        );
      },
    );

    it("sheds search-freshness rather than silently falling back to primary when the replica is faulted", () => {
      const router = new ReplicaRouter(primary, replica);
      expect(() => router.routeWithFaultAwareness("search-freshness", false)).toThrow(
        ReplicaShedError,
      );
    });

    it(
      "falls through to primary when no replica is configured — this is not a fault condition, " +
        "just an unconfigured single-node deployment",
      () => {
        const router = new ReplicaRouter(primary, null);
        expect(router.routeWithFaultAwareness("analytics-refresh", true).id).toBe("primary");
        expect(router.routeWithFaultAwareness("search-freshness", true).id).toBe("primary");
      },
    );

    it("ReplicaShedError names the work class that was refused", () => {
      const router = new ReplicaRouter(primary, replica);
      let caught: unknown;
      try {
        router.routeWithFaultAwareness("analytics-refresh", false);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ReplicaShedError);
      if (!(caught instanceof ReplicaShedError)) throw new Error("unreachable");
      expect(caught.workClass).toBe("analytics-refresh");
    });
  });

  describe("lag simulation — no physical replica is available", () => {
    it.skip(
      "PHYSICAL REPLICA NOT PROVISIONED. To complete this row: provision a Neon read-replica endpoint, " +
        "set DB_REPLICA_URL to its connection string, point a FaultServer at that endpoint to simulate lag, " +
        "and assert that reads through the replica carry REPEATABLE READ staleness matching the injected delay. " +
        "Without a physical replica the routing seam is exercised only at the pool-selection level (above), " +
        "not at the data-staleness level.",
      () => {},
    );
  });
});
