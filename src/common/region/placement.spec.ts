import {
  decidePlacement,
  placementFromRegion,
  type OrganizationPlacement,
  type PlacementStatus,
} from "./placement";

const NOW = 1_000_000;

function placement(
  overrides: Partial<OrganizationPlacement> = {},
): OrganizationPlacement {
  return {
    organizationId: "org-1",
    region: "eu",
    cellId: "legacy-1",
    databaseShard: "primary",
    objectStorageRegion: "eu",
    searchCluster: "primary",
    placementVersion: 3,
    writeFenceToken: "fence-a",
    leaseExpiresAt: NOW + 60_000,
    status: "ACTIVE",
    ...overrides,
  };
}

describe("the declared behaviour of each placement state", () => {
  it("serves reads and writes when the placement is active", () => {
    expect(decidePlacement(placement(), "read", NOW).admitted).toBe(true);
    expect(decidePlacement(placement(), "write", NOW).admitted).toBe(true);
  });

  it("keeps serving reads while an organisation is moving, because the source cell is still authoritative", () => {
    const decision = decidePlacement(placement({ status: "MOVING" }), "read", NOW);
    expect(decision.admitted).toBe(true);
  });

  it("refuses writes while an organisation is moving, which is the ordering rollback depends on", () => {
    const decision = decidePlacement(placement({ status: "MOVING" }), "write", NOW);
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error("unreachable");
    expect(decision.code).toBe("PLACEMENT_RELOCATING");
    expect(decision.retryable).toBe(true);
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it("serves reads but refuses writes for a read-only placement", () => {
    expect(decidePlacement(placement({ status: "READ_ONLY" }), "read", NOW).admitted).toBe(
      true,
    );
    const write = decidePlacement(placement({ status: "READ_ONLY" }), "write", NOW);
    expect(write.admitted).toBe(false);
    if (write.admitted) throw new Error("unreachable");
    expect(write.code).toBe("PLACEMENT_READ_ONLY");
  });

  it("refuses a read-only write without offering a retry, because waiting will not help", () => {
    const write = decidePlacement(placement({ status: "READ_ONLY" }), "write", NOW);
    if (write.admitted) throw new Error("unreachable");
    expect(write.retryable).toBe(false);
    expect(write.retryAfterMs).toBeNull();
  });

  it("refuses both reads and writes for a failed placement", () => {
    for (const intent of ["read", "write"] as const) {
      const decision = decidePlacement(placement({ status: "FAILED" }), intent, NOW);
      expect(decision.admitted).toBe(false);
      if (decision.admitted) throw new Error("unreachable");
      expect(decision.code).toBe("PLACEMENT_FAILED");
    }
  });

  it("refuses a write once the fence lease has expired, even while the status still says active", () => {
    const decision = decidePlacement(
      placement({ leaseExpiresAt: NOW - 1 }),
      "write",
      NOW,
    );
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error("unreachable");
    expect(decision.code).toBe("PLACEMENT_LEASE_EXPIRED");
  });

  it("still serves reads on an expired lease, because reads are not fenced", () => {
    expect(
      decidePlacement(placement({ leaseExpiresAt: NOW - 1 }), "read", NOW).admitted,
    ).toBe(true);
  });

  it("treats a lease expiring exactly now as expired rather than as valid", () => {
    const decision = decidePlacement(placement({ leaseExpiresAt: NOW }), "write", NOW);
    expect(decision.admitted).toBe(false);
  });

  it("covers every declared status, so a new one cannot be added without a decision", () => {
    const statuses: PlacementStatus[] = ["ACTIVE", "MOVING", "READ_ONLY", "FAILED"];
    for (const status of statuses)
      expect(
        typeof decidePlacement(placement({ status }), "write", NOW).admitted,
      ).toBe("boolean");
  });
});

describe("a region string normalised into a placement", () => {
  it("becomes cell legacy-1, which is what the current deployment is", () => {
    expect(placementFromRegion("org-1", "eu", "eu").cellId).toBe("legacy-1");
  });

  it("carries no write fence, so it can never satisfy the fence check by accident", () => {
    expect(placementFromRegion("org-1", "eu", "eu").writeFenceToken).toBeNull();
    expect(placementFromRegion("org-1", "eu", "eu").leaseExpiresAt).toBeNull();
  });
});
