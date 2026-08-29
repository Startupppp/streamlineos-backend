import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Response } from "express";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { invAuditExportJobs } from "../../../db/schema";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import {
  AUDIT_EXPORT_SCHEMA_VERSION,
  AuditExportStream,
  encodeManifestLine,
  encodeRowLine,
  encodeSectionHeaderLine,
  type AuditExportSection,
} from "./audit-export-document";
import {
  LEDGER_LOCATION_COLUMN,
  countSection,
  isEvidenceSettled,
  pinEvidence,
  readSection,
} from "./audit-export-rows";
import {
  AUDIT_EXPORT_JOB_COLUMNS,
  jobIsCoveredBy,
  jobVisibilityPredicate,
  manifestOf,
  toAuditExportJobDto,
  toSections,
  windowOf,
  type AuditExportJobRow,
} from "./audit-export-job";
import type {
  CreateAuditExportJobInput,
  ListAuditExportJobsQueryInput,
} from "./dto/audit-export.schemas";

const CHUNK_SIZE = 1000;
const SETTLE_ATTEMPTS = 10;
const SETTLE_DELAY_MS = 300;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class AuditExportService {
  private readonly logger = new Logger(AuditExportService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /**
   * Pins an evidence version, records it, and computes the checksum after the
   * request commits. The pin is read before the job row is written, so the
   * ceilings describe a snapshot the job itself is not part of.
   */
  async createJob(orgId: string, userId: string, input: CreateAuditExportJobInput) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const pin = await pinEvidence(this.db, orgId);

    const sections: AuditExportSection[] = scope === null ? ["ledger", "audit_events"] : ["ledger"];
    const auditCeilingId = sections.includes("audit_events") ? pin.auditCeilingId : 0;
    const evidenceVersion = sections
      .map((section) => (section === "ledger" ? `L${pin.ledgerCeilingId}` : `A${auditCeilingId}`))
      .join(".");

    const [job] = await this.db
      .insert(invAuditExportJobs)
      .values({
        orgId,
        status: "PENDING",
        schemaVersion: AUDIT_EXPORT_SCHEMA_VERSION,
        evidenceVersion,
        ledgerCeilingId: pin.ledgerCeilingId,
        auditCeilingId,
        pinnedXmax: pin.pinnedXmax,
        scopeWarehouseIds: scope === null ? null : [...scope].sort((a, b) => a - b),
        sections,
        filterFrom: input.from ?? null,
        filterTo: input.to ?? null,
        createdBy: userId,
      })
      .returning(AUDIT_EXPORT_JOB_COLUMNS);

    if (!job) throw new BadRequestException("Failed to create audit export job");

    await this.cache.invalidateNamespace(CACHE_KEYS.invAuditExportJobsNamespace(orgId));

    const deferred = registerAfterCommit(() => this.complete(orgId, job.id));
    if (!deferred) await this.complete(orgId, job.id);

    return toAuditExportJobDto(job);
  }

  async list(orgId: string, userId: string, query: ListAuditExportJobsQueryInput) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const { page, limit } = query;
    const offset = (page - 1) * limit;
    const visible = jobVisibilityPredicate(scope);

    return this.cache.cachedVersioned(
      CACHE_KEYS.invAuditExportJobsNamespace(orgId),
      `${this.warehouseScope.scopeKey(scope)}:${limit}:${offset}`,
      async () => {
        const rows = await this.db
          .select({ ...AUDIT_EXPORT_JOB_COLUMNS, windowTotal: sql<string>`count(*) OVER ()` })
          .from(invAuditExportJobs)
          .where(and(eq(invAuditExportJobs.orgId, orgId), visible))
          .orderBy(desc(invAuditExportJobs.createdAt))
          .limit(limit)
          .offset(offset);

        const first = rows[0];
        let total = 0;
        if (first) {
          total = Number(first.windowTotal);
        } else if (offset > 0) {
          const fallback = await this.db
            .select({ n: sql<string>`count(*)` })
            .from(invAuditExportJobs)
            .where(and(eq(invAuditExportJobs.orgId, orgId), visible));
          total = Number(fallback[0]?.n ?? 0);
        }

        return {
          items: rows.map(({ windowTotal: _total, ...job }) => toAuditExportJobDto(job)),
          total,
          page,
          totalPages: Math.ceil(total / limit),
        };
      },
      CACHE_TTL.SHORT,
    );
  }

  async findOne(orgId: string, userId: string, jobId: number) {
    return toAuditExportJobDto(await this.requireCoveredJob(orgId, userId, jobId));
  }

  /**
   * Streams the document rather than materialising it. Nothing is stored: the
   * bytes are a function of the pinned version, the job's scope and its
   * filters, so every download of a completed job reproduces the same file.
   */
  async download(orgId: string, userId: string, jobId: number, res: Response): Promise<void> {
    const job = await this.requireReadyJob(orgId, userId, jobId);

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="inventory-audit-export-${job.id}.ndjson"`);
    res.setHeader("X-Audit-Export-Schema-Version", String(job.schemaVersion));
    res.setHeader("X-Audit-Export-Evidence-Version", job.evidenceVersion);
    res.setHeader("X-Audit-Export-Checksum", `sha-256=${job.checksum ?? ""}`);

    const write = (chunk: Buffer): Promise<void> =>
      res.write(chunk)
        ? Promise.resolve()
        : new Promise((resolve) => res.once("drain", () => resolve()));

    const produced = await this.stream(job, write);
    res.end();

    if (produced.checksum !== job.checksum)
      this.logger.error(
        `audit export ${String(job.id)} for org ${orgId} no longer reproduces its recorded checksum: recorded ${String(job.checksum)}, produced ${produced.checksum}`,
      );
  }

  /** Re-derives the document and compares. A mismatch means the evidence moved. */
  async verify(orgId: string, userId: string, jobId: number) {
    const job = await this.requireReadyJob(orgId, userId, jobId);
    const produced = await this.stream(job);
    return {
      jobId: job.id,
      schemaVersion: job.schemaVersion,
      evidenceVersion: job.evidenceVersion,
      checksumAlgorithm: "sha-256",
      expectedChecksum: job.checksum,
      actualChecksum: produced.checksum,
      expectedByteLength: job.byteLength,
      actualByteLength: produced.byteLength,
      match: produced.checksum === job.checksum && produced.byteLength === job.byteLength,
    };
  }

  private async complete(orgId: string, jobId: number): Promise<void> {
    try {
      const job = await this.loadJob(orgId, jobId);
      if (job.status !== "PENDING") return;

      if (!(await this.awaitSettlement(job.pinnedXmax))) {
        await this.markFailed(orgId, jobId, "EVIDENCE_NOT_SETTLED");
        return;
      }

      const window = windowOf(job, this.locationScopeOf(job));
      const counts: Record<AuditExportSection, number> = { ledger: 0, audit_events: 0 };
      for (const section of toSections(job.sections))
        counts[section] = await countSection(this.db, section, window);

      const produced = await this.stream({
        ...job,
        ledgerRowCount: counts.ledger,
        auditRowCount: counts.audit_events,
      });

      await this.db
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

      await this.cache.invalidateNamespace(CACHE_KEYS.invAuditExportJobsNamespace(orgId));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await runInNewTenantTransaction(this.db, orgId, () =>
        this.markFailed(orgId, jobId, reason.slice(0, 500)),
      ).catch(() => undefined);
      throw error;
    }
  }

  private async awaitSettlement(pinnedXmax: string): Promise<boolean> {
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      if (await isEvidenceSettled(this.db, pinnedXmax)) return true;
      await delay(SETTLE_DELAY_MS);
    }
    return isEvidenceSettled(this.db, pinnedXmax);
  }

  private async markFailed(orgId: string, jobId: number, reason: string): Promise<void> {
    await this.db
      .update(invAuditExportJobs)
      .set({ status: "FAILED", failureReason: reason })
      .where(and(eq(invAuditExportJobs.id, jobId), eq(invAuditExportJobs.orgId, orgId)));
    await this.cache.invalidateNamespace(CACHE_KEYS.invAuditExportJobsNamespace(orgId));
  }

  private async stream(
    job: AuditExportJobRow,
    sink?: (chunk: Buffer) => Promise<void>,
  ): Promise<{ checksum: string; byteLength: number }> {
    const manifest = manifestOf(job);
    const window = windowOf(job, this.locationScopeOf(job));
    const stream = new AuditExportStream(sink);

    await stream.line(encodeManifestLine(manifest));
    for (const section of manifest.sections) {
      await stream.line(encodeSectionHeaderLine(section));
      for await (const row of readSection(this.db, section, window, CHUNK_SIZE))
        await stream.line(encodeRowLine(row));
    }

    return { checksum: stream.checksum(), byteLength: stream.byteLength };
  }

  private locationScopeOf(job: AuditExportJobRow) {
    return this.warehouseScope.locationPredicate(job.scopeWarehouseIds, LEDGER_LOCATION_COLUMN);
  }

  private async requireCoveredJob(
    orgId: string,
    userId: string,
    jobId: number,
  ): Promise<AuditExportJobRow> {
    const job = await this.loadJob(orgId, jobId);
    const scope = await this.warehouseScope.resolve(orgId, userId);
    if (!jobIsCoveredBy(job, scope)) throw new NotFoundException("Audit export job not found");
    return job;
  }

  private async requireReadyJob(
    orgId: string,
    userId: string,
    jobId: number,
  ): Promise<AuditExportJobRow> {
    const job = await this.requireCoveredJob(orgId, userId, jobId);
    if (job.status !== "COMPLETED" || !job.checksum)
      throw new BadRequestException("Audit export is not ready");
    return job;
  }

  private async loadJob(orgId: string, jobId: number): Promise<AuditExportJobRow> {
    const [job] = await this.db
      .select(AUDIT_EXPORT_JOB_COLUMNS)
      .from(invAuditExportJobs)
      .where(and(eq(invAuditExportJobs.id, jobId), eq(invAuditExportJobs.orgId, orgId)))
      .limit(1);
    if (!job) throw new NotFoundException("Audit export job not found");
    return job;
  }
}
