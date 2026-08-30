import { admits, utilisationRatio } from "./cell-capacity";
import type { CellUtilisation } from "./cell-capacity";

export type TenantClass = "SHARED" | "DEDICATED";

export type RejectionCode =
  | "WRONG_REGION"
  | "MISSING_COMPLIANCE"
  | "CELL_FULL"
  | "WRONG_TENANT_CLASS"
  | "NOT_DEDICATED_CELL";

export interface CellRejection {
  readonly cellId: string;
  readonly code: RejectionCode;
}

export interface DedicatedPin {
  readonly cellId: string;
}

export interface PlacementRequest {
  readonly organizationId: string;
  readonly region: string;
  readonly complianceRequirements: readonly string[];
  readonly tenantClass: TenantClass;
  readonly dedicatedPin?: DedicatedPin;
  readonly perOrgCost: number;
}

export interface CellCandidate {
  readonly cellId: string;
  readonly region: string;
  readonly complianceZones: readonly string[];
  readonly utilisation: CellUtilisation;
  readonly acceptedTenantClasses: readonly TenantClass[];
}

export type SelectionResult =
  | {
      readonly admitted: true;
      readonly cellId: string;
      readonly rejections: readonly CellRejection[];
    }
  | {
      readonly admitted: false;
      readonly rejections: readonly CellRejection[];
    };

function rejectCandidate(
  candidate: CellCandidate,
  code: RejectionCode,
  rejections: CellRejection[],
): void {
  rejections.push({ cellId: candidate.cellId, code });
}

function checkDedicatedPin(
  candidate: CellCandidate,
  pin: DedicatedPin | undefined,
): boolean {
  if (pin === undefined) return true;
  return pin.cellId === candidate.cellId;
}

export function selectCell(
  candidates: readonly CellCandidate[],
  request: PlacementRequest,
): SelectionResult {
  const rejections: CellRejection[] = [];

  const sorted = [...candidates].sort(
    (a, b) => utilisationRatio(a.utilisation) - utilisationRatio(b.utilisation),
  );

  for (const candidate of sorted) {
    if (candidate.region !== request.region) {
      rejectCandidate(candidate, "WRONG_REGION", rejections);
      continue;
    }

    if (!candidate.acceptedTenantClasses.includes(request.tenantClass)) {
      rejectCandidate(candidate, "WRONG_TENANT_CLASS", rejections);
      continue;
    }

    if (
      request.tenantClass === "DEDICATED" &&
      !checkDedicatedPin(candidate, request.dedicatedPin)
    ) {
      rejectCandidate(candidate, "NOT_DEDICATED_CELL", rejections);
      continue;
    }

    const missingCompliance = request.complianceRequirements.find(
      (r) => !candidate.complianceZones.includes(r),
    );
    if (missingCompliance !== undefined) {
      rejectCandidate(candidate, "MISSING_COMPLIANCE", rejections);
      continue;
    }

    if (!admits(candidate.utilisation)) {
      rejectCandidate(candidate, "CELL_FULL", rejections);
      continue;
    }

    return { admitted: true, cellId: candidate.cellId, rejections };
  }

  return { admitted: false, rejections };
}
