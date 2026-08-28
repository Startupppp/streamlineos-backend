describe("Read replica degraded — correctness-sensitive reads go to primary", () => {
  it.skip(
    "not testable yet: no read-replica routing infrastructure exists in this codebase. The system has multi-region geo-shards (RegionRegistry) but no within-region read replicas. When read replicas are introduced, this spec must verify: correctness-sensitive reads (RBAC resolution, permission cache misses, financial ledger) always route to primary; stale-tolerant projections (analytics aggregates, search indexes, non-critical list queries) may shed to a replica; when a replica is unavailable the primary absorbs all traffic without data loss; a query explicitly marked replica-tolerant does not fall back to primary, it sheds instead.",
    () => {},
  );

  it.skip(
    "what is needed to unblock this test: a ReplicaRouter or ReadStrategy abstraction that routes queries to primary vs replica based on staleness tolerance; a mechanism to mark a query as replica-safe; a fault server pointed at the replica endpoint; assertions that correctness-sensitive reads land on primary even when the replica is healthy.",
    () => {},
  );
});
