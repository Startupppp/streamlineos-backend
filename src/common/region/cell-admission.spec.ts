import {
  CellAdmissionRefusedError,
  decideRegion,
  MEASUREMENT_STALE_AFTER_MS,
  type AdmissionDeps,
} from "./cell-admission";
import type { CellRejection, TenantClass } from "../placement/placement-selection";

const NOW = 1_800_000_000_000;

interface Recorded {
  organizationId: string;
  region: string;
  tenantClass: TenantClass;
  admitted: boolean;
  selectedCellId: string | null;
  rejections: readonly CellRejection[];
}

function cell(
  cellId: string,
  region: string,
  overrides: Partial<{
    acceptedTenantClasses: readonly TenantClass[];
    complianceZones: readonly string[];
  }> = {},
) {
  return {
    region,
    cellId,
    acceptedTenantClasses: overrides.acceptedTenantClasses ?? (["SHARED"] as const),
    complianceZones: overrides.complianceZones ?? [region],
  };
}

function deps(
  cells: AdmissionDeps["cells"],
  measurements: Record<string, { used: number; limit: number; measuredAt?: number }>,
): { deps: AdmissionDeps; recorded: Recorded[] } {
  const recorded: Recorded[] = [];

  return {
    recorded,
    deps: {
      cells,
      measurementFor: async (cellId) => {
        const m = measurements[cellId];
        if (!m) return null;
        const measuredAt = m.measuredAt ?? NOW;
        if (NOW - measuredAt > MEASUREMENT_STALE_AFTER_MS) return null;
        return {
          perOrgCost: 10,
          utilisation: {
            cellId,
            limitingResource: "database-size",
            used: m.used,
            limit: m.limit,
            measuredAt,
          },
        };
      },
      recordDecision: async (decision) => {
        recorded.push(decision);
      },
    },
  };
}

describe("choosing a cell for a new organisation", () => {
  it("picks the emptiest measured cell in the requested region", async () => {
    const { deps: d } = deps(
      [cell("cell-a", "primary"), cell("cell-b", "primary")],
      { "cell-a": { used: 50, limit: 100 }, "cell-b": { used: 10, limit: 100 } },
    );

    const choice = await decideRegion(d, { organizationId: "org-1" }, "primary");

    expect(choice.kind).toBe("selected");
    if (choice.kind !== "selected") throw new Error("expected a selection");
    expect(choice.cellId).toBe("cell-b");
  });

  it("records why each cell it passed over was rejected, so the decision is explainable", async () => {
    const { deps: d, recorded } = deps(
      [
        cell("cell-a", "primary", { acceptedTenantClasses: ["DEDICATED"] }),
        cell("cell-b", "primary"),
      ],
      { "cell-a": { used: 10, limit: 100 }, "cell-b": { used: 50, limit: 100 } },
    );

    await decideRegion(d, { organizationId: "org-1" }, "primary");

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.admitted).toBe(true);
    expect(recorded[0]?.selectedCellId).toBe("cell-b");
    expect(recorded[0]?.rejections).toEqual([
      { cellId: "cell-a", code: "WRONG_TENANT_CLASS" },
    ]);
  });

  it("stops at the first admitting cell, so a fuller cell behind the winner is never rejected", async () => {
    const { deps: d, recorded } = deps(
      [cell("cell-a", "primary"), cell("cell-b", "primary")],
      { "cell-a": { used: 90, limit: 100 }, "cell-b": { used: 10, limit: 100 } },
    );

    await decideRegion(d, { organizationId: "org-1" }, "primary");

    expect(recorded[0]?.selectedCellId).toBe("cell-b");
    expect(recorded[0]?.rejections).toEqual([]);
  });

  it("refuses when every measured cell is past the admission threshold", async () => {
    const { deps: d, recorded } = deps([cell("cell-a", "primary")], {
      "cell-a": { used: 61, limit: 100 },
    });

    await expect(
      decideRegion(d, { organizationId: "org-1" }, "primary"),
    ).rejects.toBeInstanceOf(CellAdmissionRefusedError);

    expect(recorded[0]?.admitted).toBe(false);
    expect(recorded[0]?.rejections).toEqual([{ cellId: "cell-a", code: "CELL_FULL" }]);
  });

  it("refuses at 60% exactly, not above it", async () => {
    const { deps: d } = deps([cell("cell-a", "primary")], {
      "cell-a": { used: 60, limit: 100 },
    });

    await expect(
      decideRegion(d, { organizationId: "org-1" }, "primary"),
    ).rejects.toBeInstanceOf(CellAdmissionRefusedError);
  });

  it("treats an unmeasured cell as no candidate rather than as an empty one", async () => {
    const { deps: d } = deps([cell("cell-a", "primary"), cell("cell-b", "primary")], {
      "cell-a": { used: 10, limit: 100 },
    });

    const choice = await decideRegion(d, { organizationId: "org-1" }, "primary");

    expect(choice.kind).toBe("selected");
    if (choice.kind !== "selected") throw new Error("expected a selection");
    expect(choice.cellId).toBe("cell-a");
  });

  it("treats a stale measurement as no measurement", async () => {
    const { deps: d } = deps([cell("cell-a", "primary")], {
      "cell-a": { used: 10, limit: 100, measuredAt: NOW - MEASUREMENT_STALE_AFTER_MS - 1 },
    });

    const choice = await decideRegion(d, { organizationId: "org-1" }, "primary");

    expect(choice.kind).toBe("unmeasured-fallback");
  });

  it("falls back to the primary and records it when no cell has been measured", async () => {
    const { deps: d, recorded } = deps([cell("cell-a", "primary")], {});

    const choice = await decideRegion(d, { organizationId: "org-1" }, "primary");

    expect(choice.kind).toBe("unmeasured-fallback");
    if (choice.kind !== "unmeasured-fallback") throw new Error("expected a fallback");
    expect(choice.region).toBe("primary");
    expect(choice.reason).toContain("capacity measurement");
    expect(recorded[0]?.selectedCellId).toBeNull();
  });

  it("never places a dedicated tenant on a shared cell", async () => {
    const { deps: d } = deps(
      [cell("shared", "primary"), cell("dedicated", "primary", { acceptedTenantClasses: ["DEDICATED"] })],
      { shared: { used: 1, limit: 100 }, dedicated: { used: 50, limit: 100 } },
    );

    const choice = await decideRegion(
      d,
      { organizationId: "big-tenant", tenantClass: "DEDICATED", dedicatedCellId: "dedicated" },
      "primary",
    );

    expect(choice.kind).toBe("selected");
    if (choice.kind !== "selected") throw new Error("expected a selection");
    expect(choice.cellId).toBe("dedicated");
  });

  it("refuses rather than placing into a cell in another region", async () => {
    const { deps: d, recorded } = deps([cell("cell-eu", "eu")], {
      "cell-eu": { used: 1, limit: 100 },
    });

    await expect(
      decideRegion(d, { organizationId: "org-1" }, "primary"),
    ).rejects.toBeInstanceOf(CellAdmissionRefusedError);

    expect(recorded[0]?.rejections).toEqual([{ cellId: "cell-eu", code: "WRONG_REGION" }]);
  });

  it("refuses a cell that does not carry a required compliance zone", async () => {
    const { deps: d, recorded } = deps(
      [cell("cell-a", "primary", { complianceZones: ["primary"] })],
      { "cell-a": { used: 1, limit: 100 } },
    );

    await expect(
      decideRegion(
        d,
        { organizationId: "org-1", complianceRequirements: ["gdpr"] },
        "primary",
      ),
    ).rejects.toBeInstanceOf(CellAdmissionRefusedError);

    expect(recorded[0]?.rejections).toEqual([
      { cellId: "cell-a", code: "MISSING_COMPLIANCE" },
    ]);
  });
});
