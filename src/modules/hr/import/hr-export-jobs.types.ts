import {
  hrExportJobs,
  type HrExportDataScope,
  type HrExportJobStatus,
} from "../../../db/schema";
import { SCOPE_RANK } from "../../access/access.service";

export type HrExportJobRow = typeof hrExportJobs.$inferSelect;

export interface HrExportJobView {
  id: string;
  entity: "employees";
  status: HrExportJobStatus;
  processedRows: number;
  rowCount: number | null;
  fileName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
}

export class HrExportProcessingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HrExportProcessingError";
  }
}

export function narrowestExportScope(
  requested: HrExportDataScope,
  current: HrExportDataScope,
): HrExportDataScope {
  return SCOPE_RANK[requested] <= SCOPE_RANK[current] ? requested : current;
}

export function isExportScopeStillAllowed(
  exportedScope: HrExportDataScope,
  currentScope: HrExportDataScope,
): boolean {
  return SCOPE_RANK[exportedScope] <= SCOPE_RANK[currentScope];
}

export function isHrExportWorkerEnabled(): boolean {
  return process.env.HR_EXPORT_WORKER_ENABLED === "true";
}
