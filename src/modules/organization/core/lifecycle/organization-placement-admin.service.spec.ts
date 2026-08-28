import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.types";
import type { AuditService } from "../../../../common/audit/audit.service";
import { decidePlacement } from "../../../../common/region/placement";
import {
  fetchPlacementRow,
  transitionPlacementStatus,
} from "../../../../common/region/placement-lookup";
import type { PlacementTransitionRow } from "../../../../common/region/placement-lookup";
import { hasRegionRegistry, getRegionRegistry } from "../../../../common/region/region-registry";
import {
  isTransitionAllowed,
  OrganizationPlacementAdminService,
} from "./organization-placement-admin.service";

jest.mock("../../../../common/region/placement-lookup");
jest.mock("../../../../common/region/region-registry");

const mockFetch = jest.mocked(fetchPlacementRow);
const mockTransition = jest.mocked(transitionPlacementStatus);
const mockHasRegistry = jest.mocked(hasRegionRegistry);
const mockGetRegistry = jest.mocked(getRegionRegistry);

function makeRow(overrides: Partial<PlacementTransitionRow> = {}): PlacementTransitionRow {
  return {
    organizationId: "org-1",
    placementVersion: 5,
    writeFenceToken: "token-abc",
    status: "ACTIVE",
    leaseExpiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

let service: OrganizationPlacementAdminService;
let auditLog: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockHasRegistry.mockReturnValue(false);
  auditLog = jest.fn();
  const audit = { log: auditLog, logCritical: jest.fn() } as unknown as AuditService;
  service = new OrganizationPlacementAdminService({} as unknown as Db, audit);
});

describe("isTransitionAllowed", () => {
  it("permits the expected legal edges", () => {
    expect(isTransitionAllowed("ACTIVE", "MOVING")).toBe(true);
    expect(isTransitionAllowed("ACTIVE", "READ_ONLY")).toBe(true);
    expect(isTransitionAllowed("ACTIVE", "FAILED")).toBe(true);
    expect(isTransitionAllowed("MOVING", "ACTIVE")).toBe(true);
    expect(isTransitionAllowed("MOVING", "READ_ONLY")).toBe(true);
    expect(isTransitionAllowed("MOVING", "FAILED")).toBe(true);
    expect(isTransitionAllowed("READ_ONLY", "ACTIVE")).toBe(true);
    expect(isTransitionAllowed("READ_ONLY", "FAILED")).toBe(true);
    expect(isTransitionAllowed("FAILED", "ACTIVE")).toBe(true);
  });

  it("rejects the illegal edges, including FAILED → MOVING which is pinned as disallowed", () => {
    expect(isTransitionAllowed("FAILED", "MOVING")).toBe(false);
    expect(isTransitionAllowed("FAILED", "READ_ONLY")).toBe(false);
    expect(isTransitionAllowed("FAILED", "FAILED")).toBe(false);
    expect(isTransitionAllowed("ACTIVE", "ACTIVE")).toBe(false);
    expect(isTransitionAllowed("MOVING", "MOVING")).toBe(false);
    expect(isTransitionAllowed("READ_ONLY", "MOVING")).toBe(false);
    expect(isTransitionAllowed("READ_ONLY", "READ_ONLY")).toBe(false);
  });
});

describe("current()", () => {
  it("returns the placement row when it exists", async () => {
    const row = makeRow();
    mockFetch.mockResolvedValue(row);
    await expect(service.current("org-1")).resolves.toEqual(row);
  });

  it("throws NotFoundException when the org has no placement row", async () => {
    mockFetch.mockResolvedValue(null);
    await expect(service.current("org-missing")).rejects.toThrow(NotFoundException);
  });
});

describe("markMoving()", () => {
  it("transitions ACTIVE → MOVING and bumps placementVersion and rotates writeFenceToken", async () => {
    const original = makeRow({ status: "ACTIVE", placementVersion: 5, writeFenceToken: "token-old" });
    const updated = makeRow({ status: "MOVING", placementVersion: 6, writeFenceToken: "token-new" });
    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);

    const result = await service.markMoving("org-1", "user-1");

    expect(result.status).toBe("MOVING");
    expect(result.placementVersion).toBeGreaterThan(original.placementVersion);
    expect(result.writeFenceToken).not.toBe(original.writeFenceToken);
  });

  it("passes from/to/currentVersion correctly to transitionPlacementStatus", async () => {
    const original = makeRow({ status: "ACTIVE", placementVersion: 5 });
    const updated = makeRow({ status: "MOVING", placementVersion: 6 });
    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);

    await service.markMoving("org-1", "user-1");

    expect(mockTransition).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1",
      from: "ACTIVE",
      to: "MOVING",
      currentVersion: 5,
    });
  });

  it("throws ConflictException naming both states when the transition is illegal", async () => {
    mockFetch.mockResolvedValue(makeRow({ status: "FAILED" }));

    const err = await service.markMoving("org-1", "user-1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toMatch(/FAILED/);
    expect((err as ConflictException).message).toMatch(/MOVING/);
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it("throws ConflictException when the conditional UPDATE matches zero rows", async () => {
    mockFetch.mockResolvedValue(makeRow({ status: "ACTIVE" }));
    mockTransition.mockResolvedValue(null);

    await expect(service.markMoving("org-1", "user-1")).rejects.toThrow(ConflictException);
  });

  it("throws NotFoundException when the org has no placement row", async () => {
    mockFetch.mockResolvedValue(null);
    await expect(service.markMoving("org-missing", "user-1")).rejects.toThrow(NotFoundException);
  });
});

describe("markReadOnly()", () => {
  it("transitions ACTIVE → READ_ONLY and bumps version", async () => {
    const original = makeRow({ status: "ACTIVE", placementVersion: 3 });
    const updated = makeRow({ status: "READ_ONLY", placementVersion: 4, writeFenceToken: "new-tk" });
    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);

    const result = await service.markReadOnly("org-1", "user-1");

    expect(result.status).toBe("READ_ONLY");
    expect(result.placementVersion).toBeGreaterThan(original.placementVersion);
    expect(result.writeFenceToken).not.toBe(original.writeFenceToken);
  });

  it("transitions MOVING → READ_ONLY", async () => {
    const original = makeRow({ status: "MOVING", placementVersion: 7 });
    const updated = makeRow({ status: "READ_ONLY", placementVersion: 8 });
    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);

    const result = await service.markReadOnly("org-1", "user-1");
    expect(result.status).toBe("READ_ONLY");
  });

  it("throws ConflictException for FAILED → READ_ONLY", async () => {
    mockFetch.mockResolvedValue(makeRow({ status: "FAILED" }));
    await expect(service.markReadOnly("org-1", "user-1")).rejects.toThrow(ConflictException);
    expect(mockTransition).not.toHaveBeenCalled();
  });
});

describe("markFailed()", () => {
  it("transitions ACTIVE → FAILED and includes reason in audit metadata", async () => {
    const original = makeRow({ status: "ACTIVE", placementVersion: 2 });
    const updated = makeRow({ status: "FAILED", placementVersion: 3, writeFenceToken: "new-tk" });
    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);

    const result = await service.markFailed("org-1", "user-1", "disk failure");

    expect(result.status).toBe("FAILED");
    expect(result.placementVersion).toBeGreaterThan(original.placementVersion);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: "disk failure" }),
      }),
    );
  });

  it("transitions MOVING → FAILED", async () => {
    const original = makeRow({ status: "MOVING" });
    const updated = makeRow({ status: "FAILED", placementVersion: original.placementVersion + 1 });
    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);

    const result = await service.markFailed("org-1", "user-1", "network split");
    expect(result.status).toBe("FAILED");
  });

  it("transitions READ_ONLY → FAILED", async () => {
    const original = makeRow({ status: "READ_ONLY" });
    const updated = makeRow({ status: "FAILED", placementVersion: original.placementVersion + 1 });
    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);

    const result = await service.markFailed("org-1", "user-1", "storage error");
    expect(result.status).toBe("FAILED");
  });
});

describe("markActive()", () => {
  it("transitions MOVING → ACTIVE and bumps version and rotates fence", async () => {
    const original = makeRow({ status: "MOVING", placementVersion: 9, writeFenceToken: "old-tk" });
    const updated = makeRow({ status: "ACTIVE", placementVersion: 10, writeFenceToken: "new-tk" });
    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);

    const result = await service.markActive("org-1", "user-1");

    expect(result.status).toBe("ACTIVE");
    expect(result.placementVersion).toBeGreaterThan(original.placementVersion);
    expect(result.writeFenceToken).not.toBe(original.writeFenceToken);
  });

  it("transitions READ_ONLY → ACTIVE", async () => {
    const original = makeRow({ status: "READ_ONLY" });
    const updated = makeRow({ status: "ACTIVE", placementVersion: original.placementVersion + 1 });
    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);

    const result = await service.markActive("org-1", "user-1");
    expect(result.status).toBe("ACTIVE");
  });

  it("transitions FAILED → ACTIVE", async () => {
    const original = makeRow({ status: "FAILED" });
    const updated = makeRow({ status: "ACTIVE", placementVersion: original.placementVersion + 1 });
    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);

    const result = await service.markActive("org-1", "user-1");
    expect(result.status).toBe("ACTIVE");
  });

  it("throws ConflictException for ACTIVE → ACTIVE (self-transition)", async () => {
    mockFetch.mockResolvedValue(makeRow({ status: "ACTIVE" }));
    await expect(service.markActive("org-1", "user-1")).rejects.toThrow(ConflictException);
    expect(mockTransition).not.toHaveBeenCalled();
  });
});

describe("registry cache invalidation", () => {
  it("calls forgetVersionsBelow with the new version after a successful transition", async () => {
    const original = makeRow({ status: "ACTIVE", placementVersion: 7 });
    const updated = makeRow({ status: "MOVING", placementVersion: 8 });
    const forgetVersionsBelow = jest.fn();

    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);
    mockHasRegistry.mockReturnValue(true);
    mockGetRegistry.mockReturnValue({ forgetVersionsBelow } as ReturnType<typeof getRegionRegistry>);

    await service.markMoving("org-1", "user-1");

    expect(forgetVersionsBelow).toHaveBeenCalledWith("org-1", 8);
  });

  it("skips registry invalidation when no registry is configured", async () => {
    const original = makeRow({ status: "ACTIVE" });
    const updated = makeRow({ status: "MOVING", placementVersion: original.placementVersion + 1 });
    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);
    mockHasRegistry.mockReturnValue(false);

    await service.markMoving("org-1", "user-1");

    expect(mockGetRegistry).not.toHaveBeenCalled();
  });
});

describe("the point of markMoving — withTenant fence predicate", () => {
  it("after markMoving, decidePlacement blocks writes for a placement with the new status", async () => {
    const original = makeRow({
      status: "ACTIVE",
      placementVersion: 5,
      writeFenceToken: "token-before",
    });
    const updated = makeRow({
      status: "MOVING",
      placementVersion: 6,
      writeFenceToken: "token-after",
    });

    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);

    const result = await service.markMoving("org-1", "user-1");

    expect(result.placementVersion).toBeGreaterThan(original.placementVersion);
    expect(result.writeFenceToken).not.toBe(original.writeFenceToken);
    expect(result.status).toBe("MOVING");

    const fullPlacement = {
      organizationId: "org-1",
      region: "eu",
      cellId: "legacy-1",
      databaseShard: "primary",
      objectStorageRegion: "eu",
      searchCluster: "primary",
      placementVersion: result.placementVersion,
      writeFenceToken: result.writeFenceToken,
      leaseExpiresAt: result.leaseExpiresAt.getTime(),
      status: result.status,
    };

    const writeDecision = decidePlacement(fullPlacement, "write", Date.now());
    expect(writeDecision.admitted).toBe(false);
    if (!writeDecision.admitted) expect(writeDecision.code).toBe("PLACEMENT_RELOCATING");

    const readDecision = decidePlacement(fullPlacement, "read", Date.now());
    expect(readDecision.admitted).toBe(true);
  });

  it("the three fields withTenant fenceProbe checks all change after markMoving", async () => {
    const original = makeRow({
      status: "ACTIVE",
      placementVersion: 5,
      writeFenceToken: "token-before",
    });
    const updated = makeRow({
      status: "MOVING",
      placementVersion: 6,
      writeFenceToken: "token-after",
    });

    mockFetch.mockResolvedValue(original);
    mockTransition.mockResolvedValue(updated);

    const result = await service.markMoving("org-1", "user-1");

    expect(result.placementVersion).not.toBe(original.placementVersion);
    expect(result.writeFenceToken).not.toBe(original.writeFenceToken);
    expect(result.status).not.toBe("ACTIVE");
  });
});
