import { sql, type SQL } from "drizzle-orm";
import { invAuditExportJobs } from "../../../db/schema";
import {
  AUDIT_EXPORT_SECTIONS,
  type AuditExportManifest,
  type AuditExportSection,
} from "./audit-export-document";
import type { AuditExportWindow } from "./audit-export-rows";

export const AUDIT_EXPORT_JOB_COLUMNS = {
  id: invAuditExportJobs.id,
  orgId: invAuditExportJobs.orgId,
  status: invAuditExportJobs.status,
  schemaVersion: invAuditExportJobs.schemaVersion,
  evidenceVersion: invAuditExportJobs.evidenceVersion,
  ledgerCeilingId: invAuditExportJobs.ledgerCeilingId,
  auditCeilingId: invAuditExportJobs.auditCeilingId,
  pinnedXmax: invAuditExportJobs.pinnedXmax,
  scopeWarehouseIds: invAuditExportJobs.scopeWarehouseIds,
  sections: invAuditExportJobs.sections,
  filterFrom: invAuditExportJobs.filterFrom,
  filterTo: invAuditExportJobs.filterTo,
  ledgerRowCount: invAuditExportJobs.ledgerRowCount,
  auditRowCount: invAuditExportJobs.auditRowCount,
  checksum: invAuditExportJobs.checksum,
  byteLength: invAuditExportJobs.byteLength,
  settledAt: invAuditExportJobs.settledAt,
  failureReason: invAuditExportJobs.failureReason,
  createdBy: invAuditExportJobs.createdBy,
  createdAt: invAuditExportJobs.createdAt,
  updatedAt: invAuditExportJobs.updatedAt,
} as const;

export type AuditExportJobRow = typeof invAuditExportJobs.$inferSelect;

/**
 * Narrows a stored `sections` array back to the canonical list, in the
 * canonical order. Emission order is part of what is hashed, so it is decided
 * here rather than by whatever order the column happens to hold.
 */
export function toSections(value: unknown): AuditExportSection[] {
  const declared = Array.isArray(value) ? value : [];
  return AUDIT_EXPORT_SECTIONS.filter((section) => declared.includes(section));
}

export function manifestOf(job: AuditExportJobRow): AuditExportManifest {
  const warehouseIds = job.scopeWarehouseIds;
  return {
    orgId: job.orgId,
    evidenceVersion: job.evidenceVersion,
    warehouseIds: warehouseIds === null ? null : [...warehouseIds].sort((a, b) => a - b).map(String),
    from: job.filterFrom,
    to: job.filterTo,
    sections: toSections(job.sections),
    rowCounts: { ledger: job.ledgerRowCount ?? 0, audit_events: job.auditRowCount ?? 0 },
  };
}

export function windowOf(job: AuditExportJobRow, locationScope: SQL): AuditExportWindow {
  return {
    orgId: job.orgId,
    from: job.filterFrom,
    to: job.filterTo,
    ledgerCeilingId: job.ledgerCeilingId,
    auditCeilingId: job.auditCeilingId,
    locationScope,
  };
}

/**
 * A scoped caller may only see a job whose warehouses are a subset of their
 * own, and never an org-wide one. Without this a narrow operator lists — and
 * then downloads — a wide colleague's document and reads every warehouse in it.
 */
export function jobVisibilityPredicate(scope: number[] | null): SQL {
  if (scope === null) return sql`TRUE`;
  if (scope.length === 0) return sql`FALSE`;
  return sql`${invAuditExportJobs.scopeWarehouseIds} IS NOT NULL AND ${invAuditExportJobs.scopeWarehouseIds} <@ ${JSON.stringify(scope)}::jsonb`;
}

export function jobIsCoveredBy(job: AuditExportJobRow, scope: number[] | null): boolean {
  if (scope === null) return true;
  const jobScope = job.scopeWarehouseIds;
  if (jobScope === null) return false;
  const allowed = new Set(scope);
  return jobScope.every((warehouseId) => allowed.has(warehouseId));
}

export function toAuditExportJobDto(job: AuditExportJobRow) {
  return {
    id: job.id,
    status: job.status,
    schemaVersion: job.schemaVersion,
    evidenceVersion: job.evidenceVersion,
    sections: toSections(job.sections),
    scopeWarehouseIds: job.scopeWarehouseIds,
    filterFrom: job.filterFrom,
    filterTo: job.filterTo,
    ledgerRowCount: job.ledgerRowCount,
    auditRowCount: job.auditRowCount,
    checksumAlgorithm: "sha-256",
    checksum: job.checksum,
    byteLength: job.byteLength,
    settledAt: job.settledAt,
    failureReason: job.failureReason,
    createdBy: job.createdBy,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
