import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";
import { invJobStatusEnum } from "../../../../db/schema/common/enums-inventory-fulfilment";

/**
 * `toAuditExportJobDto` (`audit-export-job.ts`) — the projection, not the row.
 *
 * The ceilings, the pinned `xmax` and the org id are selected but never
 * returned: they are how the export pins its evidence, and handing them out
 * would describe the tenant's transaction watermark to anybody who can list a
 * job. `checksumAlgorithm` is a server-authored constant, so it is a literal.
 *
 * `filterFrom`/`filterTo` are `date` columns, which postgres-js returns as
 * `YYYY-MM-DD` strings rather than `Date`s; `settledAt` is a `timestamp` and is
 * a `Date`. The two are not the same wire shape and must not be declared alike.
 */
const auditExportJobSchema = z.object({
  id: z.number().int(),
  status: z.enum(invJobStatusEnum.enumValues),
  schemaVersion: z.number().int(),
  evidenceVersion: z.string(),
  sections: z.array(z.enum(["ledger", "audit_events"])),
  scopeWarehouseIds: z.array(z.number().int()).nullable(),
  filterFrom: z.string().nullable(),
  filterTo: z.string().nullable(),
  ledgerRowCount: z.number().int().nullable(),
  auditRowCount: z.number().int().nullable(),
  checksumAlgorithm: z.literal("sha-256"),
  checksum: z.string().nullable(),
  byteLength: z.number().int().nullable(),
  settledAt: nullableWireDate(),
  failureReason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const createAuditExportJobResponseSchema = auditExportJobSchema;
export const auditExportJobResponseSchema = auditExportJobSchema;
export const listAuditExportJobsResponseSchema = itemsPagedSchema(auditExportJobSchema);

/**
 * The re-derivation. `expected*` come off the stored job and are null while it
 * has not settled; `actual*` are what re-running the document just produced.
 */
export const verifyAuditExportResponseSchema = z.object({
  jobId: z.number().int(),
  schemaVersion: z.number().int(),
  evidenceVersion: z.string(),
  checksumAlgorithm: z.literal("sha-256"),
  expectedChecksum: z.string().nullable(),
  actualChecksum: z.string(),
  expectedByteLength: z.number().int().nullable(),
  actualByteLength: z.number().int(),
  match: z.boolean(),
});
