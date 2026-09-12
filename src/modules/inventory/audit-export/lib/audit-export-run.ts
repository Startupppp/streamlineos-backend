import { and, eq } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { invAuditExportJobs } from "../../../../db/schema";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import {
  AuditExportStream,
  encodeManifestLine,
  encodeRowLine,
  encodeSectionHeaderLine,
  type AuditExportSection,
} from "../audit-export-document";
import {
  LEDGER_LOCATION_COLUMN,
  countSection,
  isEvidenceSettled,
  readSection,
} from "../audit-export-rows";
import {
  manifestOf,
  toSections,
  windowOf,
  type AuditExportJobRow,
} from "../audit-export-job";

/**
 * Producing the export: settle the evidence, write the document, stream it.
 *
 * Split from the job surface next door because the two fail differently. The
 * surface answers "may this caller see this job" and 404s; this half answers
 * "is the evidence stable enough to sign" and, when it is not, marks the job
 * FAILED with a reason rather than shipping a document that disagrees with the
 * ledger it claims to attest.
 *
 * `loadJob` is reached through the deps bag rather than imported: it is the
 * read the surface gates on, and it stays over there.
 */
export interface AuditExportRunDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly warehouseScope: WarehouseScopeService;
  readonly loadJob: (orgId: string, jobId: number) => Promise<AuditExportJobRow>;
}

const CHUNK_SIZE = 1000;
const SETTLE_ATTEMPTS = 10;
const SETTLE_DELAY_MS = 300;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function completeJob(
  deps: AuditExportRunDeps,orgId: string, jobId: number): Promise<void> {
  try {
    const job = await deps.loadJob(orgId, jobId);
    if (job.status !== "PENDING") return;

    if (!(await awaitSettlement(deps, job.pinnedXmax))) {
      await markFailed(deps, orgId, jobId, "EVIDENCE_NOT_SETTLED");
      return;
    }

    const window = windowOf(job, locationScopeOf(deps, job));
    const counts: Record<AuditExportSection, number> = { ledger: 0, audit_events: 0 };
    for (const section of toSections(job.sections))
      counts[section] = await countSection(deps.db, section, window);

    const produced = await streamJob(deps, {
      ...job,
      ledgerRowCount: counts.ledger,
      auditRowCount: counts.audit_events,
    });

    await deps.db
      .update(invAuditExportJobs)
      .set({
        status: "COMPLETED",
        ledgerRowCount: counts.ledger,
        auditRowCount: counts.audit_events,
        checksum: produced.checksum,
        byteLength: produced.byteLength,
        settledAt: new Date(),
        failureReason: null,
      })
      .where(and(eq(invAuditExportJobs.id, jobId), eq(invAuditExportJobs.orgId, orgId)));

    await deps.cache.invalidateNamespace(CACHE_KEYS.invAuditExportJobsNamespace(orgId));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await runInNewTenantTransaction(deps.db, orgId, () =>
      markFailed(deps, orgId, jobId, reason.slice(0, 500)),
    ).catch(() => undefined);
    throw error;
  }
}

export async function streamJob(
  deps: AuditExportRunDeps,
  job: AuditExportJobRow,
  sink?: (chunk: Buffer) => Promise<void>,
): Promise<{ checksum: string; byteLength: number }> {
  const manifest = manifestOf(job);
  const window = windowOf(job, locationScopeOf(deps, job));
  const stream = new AuditExportStream(sink);

  await stream.line(encodeManifestLine(manifest));
  for (const section of manifest.sections) {
    await stream.line(encodeSectionHeaderLine(section));
    for await (const row of readSection(deps.db, section, window, CHUNK_SIZE))
      await stream.line(encodeRowLine(row));
  }

  return { checksum: stream.checksum(), byteLength: stream.byteLength };
}

async function awaitSettlement(
  deps: AuditExportRunDeps,pinnedXmax: string): Promise<boolean> {
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    if (await isEvidenceSettled(deps.db, pinnedXmax)) return true;
    await delay(SETTLE_DELAY_MS);
  }
  return isEvidenceSettled(deps.db, pinnedXmax);
}

async function markFailed(
  deps: AuditExportRunDeps,orgId: string, jobId: number, reason: string): Promise<void> {
  await deps.db
    .update(invAuditExportJobs)
    .set({ status: "FAILED", failureReason: reason })
    .where(and(eq(invAuditExportJobs.id, jobId), eq(invAuditExportJobs.orgId, orgId)));
  await deps.cache.invalidateNamespace(CACHE_KEYS.invAuditExportJobsNamespace(orgId));
}

function locationScopeOf(
  deps: AuditExportRunDeps,job: AuditExportJobRow) {
  return deps.warehouseScope.locationPredicate(job.scopeWarehouseIds, LEDGER_LOCATION_COLUMN);
}
