import { poolEnvShape, resolvePoolConfig } from "../db/pool.config";
import { shedRank, isReserved } from "../common/admission/work-class";

describe("Read replica degraded — correctness-sensitive reads go to primary", () => {
  describe("single-connection ratchet: no read-replica routing seam exists today", () => {
    it(
      "poolEnvShape declares no REPLICA-shaped environment variable — adding one must come with a routing seam",
      () => {
        const replicaKeys = Object.keys(poolEnvShape).filter((k) => /REPLICA/i.test(k));
        expect(replicaKeys).toEqual([]);
      },
    );

    it(
      "resolvePoolConfig returns exactly one connectionString — not a primary/replica pair",
      () => {
        const config = resolvePoolConfig({
          APP_DATABASE_URL: "postgres://user:pass@localhost/db",
        });
        expect(typeof config.connectionString).toBe("string");
        const replicaKeys = Object.keys(config).filter((k) => /replica/i.test(k));
        expect(replicaKeys).toEqual([]);
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

  it.skip(
    "NEEDS: a configured replica connection consumed by resolvePoolConfig (e.g. REPLICA_DATABASE_URL in poolEnvShape) " +
      "AND a routing seam (ReplicaRouter or ReadStrategy abstraction) that tags each query as primary-required or replica-safe " +
      "AND an observable handle — e.g. a mock Db that records which pool received the query — so assertions can verify routing decisions. " +
      "Once those exist: assert RBAC resolution, permission-cache misses and financial-ledger reads always land on primary; " +
      "assert analytics-refresh and search-freshness work-classes land on the replica; " +
      "assert that when the replica is faulted (FaultServer pointed at its endpoint) those classes shed rather than " +
      "falling back to the primary and silently staling correctness-sensitive traffic.",
    () => {},
  );
});
