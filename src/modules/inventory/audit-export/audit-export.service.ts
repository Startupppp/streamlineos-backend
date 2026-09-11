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
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import {
  AUDIT_EXPORT_SCHEMA_VERSION,
  type AuditExportSection,
} from "./audit-export-document";
import {
  pinEvidence,
} from "./audit-export-rows";
import {
  AUDIT_EXPORT_JOB_COLUMNS,
  jobIsCoveredBy,
  jobVisibilityPredicate,
  toAuditExportJobDto,
  type AuditExportJobRow,
} from "./audit-export-job";
import {
  completeJob,
  streamJob,
  type AuditExportRunDeps,
} from "./lib/audit-export-run";
import type {
  CreateAuditExportJobInput,
  ListAuditExportJobsQueryInput,
} from "./dto/audit-export.schemas";

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

    const deferred = registerAfterCommit(() => completeJob(this.runDeps, orgId, job.id));
    if (!deferred) await completeJob(this.runDeps, orgId, job.id);

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

    const produced = await streamJob(this.runDeps, job, write);
    res.end();

    if (produced.checksum !== job.checksum)
      this.logger.error(
        `audit export ${String(job.id)} for org ${orgId} no longer reproduces its recorded checksum: recorded ${String(job.checksum)}, produced ${produced.checksum}`,
      );
  }

  /** Re-derives the document and compares. A mismatch means the evidence moved. */
  async verify(orgId: string, userId: string, jobId: number) {
    const job = await this.requireReadyJob(orgId, userId, jobId);
    const produced = await streamJob(this.runDeps, job);
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

  private get runDeps(): AuditExportRunDeps {
    return {
      db: this.db,
      cache: this.cache,
      warehouseScope: this.warehouseScope,
      loadJob: (orgId, jobId) => this.loadJob(orgId, jobId),
    };
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
