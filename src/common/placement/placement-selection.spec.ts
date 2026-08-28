import { selectCell } from "./placement-selection";
import type { CellCandidate, PlacementRequest } from "./placement-selection";
import type { CellUtilisation } from "./cell-capacity";
import { ADMISSION_THRESHOLD } from "./cell-capacity";

function utilisation(used: number, cellId = "cell-1"): CellUtilisation {
  return { cellId, limitingResource: "cpu", used, limit: 100, measuredAt: 0 };
}

function candidate(overrides: Partial<CellCandidate> = {}): CellCandidate {
  return {
    cellId: "cell-1",
    region: "eu",
    complianceZones: ["gdpr"],
    utilisation: utilisation(10),
    acceptedTenantClasses: ["SHARED"],
    ...overrides,
  };
}

function request(overrides: Partial<PlacementRequest> = {}): PlacementRequest {
  return {
    organizationId: "org-1",
    region: "eu",
    complianceRequirements: ["gdpr"],
    tenantClass: "SHARED",
    perOrgCost: 5,
    ...overrides,
  };
}

describe("selectCell", () => {
  it("admits a matching cell and returns its id", () => {
    const result = selectCell([candidate()], request());
    expect(result.admitted).toBe(true);
    if (result.admitted) expect(result.cellId).toBe("cell-1");
  });

  it("rejects cells in the wrong region", () => {
    const result = selectCell(
      [candidate({ region: "us" })],
      request({ region: "eu" }),
    );
    expect(result.admitted).toBe(false);
    expect(result.rejections[0]?.code).toBe("WRONG_REGION");
  });

  it("rejects cells missing a required compliance zone", () => {
    const result = selectCell(
      [candidate({ complianceZones: ["gdpr"] })],
      request({ complianceRequirements: ["gdpr", "hipaa"] }),
    );
    expect(result.admitted).toBe(false);
    expect(result.rejections[0]?.code).toBe("MISSING_COMPLIANCE");
  });

  it("rejects cells that are full", () => {
    const fullUtil = utilisation(Math.ceil(ADMISSION_THRESHOLD * 100));
    const result = selectCell(
      [candidate({ utilisation: fullUtil })],
      request(),
    );
    expect(result.admitted).toBe(false);
    expect(result.rejections[0]?.code).toBe("CELL_FULL");
  });

  it("rejects a SHARED cell for a DEDICATED tenant", () => {
    const result = selectCell(
      [candidate({ acceptedTenantClasses: ["SHARED"] })],
      request({ tenantClass: "DEDICATED" }),
    );
    expect(result.admitted).toBe(false);
    expect(result.rejections[0]?.code).toBe("WRONG_TENANT_CLASS");
  });

  it("a DEDICATED tenant with a pin never lands on a SHARED cell", () => {
    const sharedCell = candidate({ cellId: "shared-1", acceptedTenantClasses: ["SHARED"] });
    const dedicatedCell = candidate({
      cellId: "dedicated-1",
      acceptedTenantClasses: ["DEDICATED"],
      utilisation: utilisation(10, "dedicated-1"),
    });
    const result = selectCell(
      [sharedCell, dedicatedCell],
      request({ tenantClass: "DEDICATED", dedicatedPin: { cellId: "dedicated-1" } }),
    );
    expect(result.admitted).toBe(true);
    if (result.admitted) expect(result.cellId).toBe("dedicated-1");
    expect(result.rejections.some((r) => r.cellId === "shared-1")).toBe(true);
  });

  it("rejects a dedicated cell that does not match the pin", () => {
    const result = selectCell(
      [candidate({ cellId: "cell-a", acceptedTenantClasses: ["DEDICATED"] })],
      request({ tenantClass: "DEDICATED", dedicatedPin: { cellId: "cell-b" } }),
    );
    expect(result.admitted).toBe(false);
    expect(result.rejections[0]?.code).toBe("NOT_DEDICATED_CELL");
  });

  it("returns not admitted when all cells are rejected", () => {
    const result = selectCell(
      [candidate({ region: "us" })],
      request({ region: "eu" }),
    );
    expect(result.admitted).toBe(false);
    expect(result.rejections.length).toBeGreaterThan(0);
  });

  it("prefers the cell with the lowest utilisation ratio", () => {
    const low = candidate({ cellId: "low", utilisation: utilisation(5, "low") });
    const high = candidate({ cellId: "high", utilisation: utilisation(30, "high") });
    const result = selectCell([high, low], request());
    expect(result.admitted).toBe(true);
    if (result.admitted) expect(result.cellId).toBe("low");
  });

  it("carries rejected cells in the result alongside an admitted cell", () => {
    const wrong = candidate({ cellId: "wrong", region: "us" });
    const right = candidate({ cellId: "right", region: "eu" });
    const result = selectCell([wrong, right], request({ region: "eu" }));
    expect(result.admitted).toBe(true);
    expect(result.rejections.length).toBeGreaterThan(0);
  });
});
