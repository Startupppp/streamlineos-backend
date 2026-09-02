import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { payrollJobs } from "../../../db/schema";
import { PayrollJobsService } from "../jobs/payroll-jobs.service";
import { PayrollEntitiesService } from "../entities/entities.service";
import { FILING_CAPABILITY, type PrepareExportBody } from "./filings.service";

export const FILING_EXPORT_RESOURCE_TYPE = "payroll_filing_export";

type PayrollJobRow = typeof payrollJobs.$inferSelect;

export type FilingExportJobView = {
  jobId: number;
  status: PayrollJobRow["status"];
  progress: number;
  filingId: number | null;
  correlationId: string | null;
  errorMessage: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  capability: typeof FILING_CAPABILITY;
  statusLabel: string;
};

/**
 * Owns the request-side seam of a statutory export: validate cheaply, enqueue a
 * durable payroll job, report its progress. The artifact itself is built by
 * PayrollFilingsService.prepareExport on the payroll jobs worker.
 */
@Injectable()
export class PayrollFilingsExportJobService {
  constructor(
    private readonly jobs: PayrollJobsService,
    private readonly entities: PayrollEntitiesService,
  ) {}

  /**
   * Request path for a statutory export.
   *
   * The artifact is a full run-wide CSV, so it is never built on the request
   * thread: this validates cheaply, enqueues a durable FILING_EXPORT job and
   * returns a job handle. Poll `getExportJob` for the resulting filing id.
   */
  async requestExport(
    orgId: string,
    actorId: string,
    body: PrepareExportBody,
  ): Promise<FilingExportJobView> {
    await this.assertExportRequestAcceptable(orgId, body);

    const resourceId = body.runId != null ? String(body.runId) : body.month ?? null;
    const job = await this.jobs.enqueue({
      orgId,
      jobType: "FILING_EXPORT",
      actorId,
      resourceType: FILING_EXPORT_RESOURCE_TYPE,
      resourceId: resourceId ?? undefined,
      payload: {
        filingType: body.filingType,
        ...(body.periodId != null ? { periodId: body.periodId } : {}),
        ...(body.entityId != null ? { entityId: body.entityId } : {}),
        ...(body.fiscalYear != null ? { fiscalYear: body.fiscalYear } : {}),
        ...(body.ruleVersion != null ? { ruleVersion: body.ruleVersion } : {}),
        ...(body.runId != null ? { runId: body.runId } : {}),
        ...(body.month != null ? { month: body.month } : {}),
        ...(body.payload ? { exportPayload: body.payload } : {}),
      },
    });

    return this.viewExportJob(job);
  }

  async getExportJob(orgId: string, jobId: number): Promise<FilingExportJobView> {
    const job = await this.jobs.get(orgId, jobId);
    if (job.jobType !== "FILING_EXPORT") {
      throw new NotFoundException("Filing export job not found");
    }
    return this.viewExportJob(job);
  }

  private viewExportJob(job: PayrollJobRow): FilingExportJobView {
    const result = (job.result ?? {}) as Record<string, unknown>;
    return {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      filingId: typeof result.filingId === "number" ? result.filingId : null,
      correlationId: job.correlationId,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      capability: FILING_CAPABILITY,
      statusLabel:
        job.status === "SUCCEEDED"
          ? FILING_CAPABILITY.honestyLabel
          : "Export queued — the CSV is being prepared",
    };
  }

  /** Cheap, read-only guards worth answering synchronously before enqueuing. */
  private async assertExportRequestAcceptable(orgId: string, body: PrepareExportBody) {
    const supportedTypes: readonly string[] = FILING_CAPABILITY.supportedTypes;
    if (!supportedTypes.includes(body.filingType)) {
      throw new BadRequestException(`Unsupported filing type: ${body.filingType}`);
    }
    if (body.entityId == null) return;

    const entity = await this.entities.getEntity(orgId, body.entityId);
    const country = entity.countryCode.toUpperCase();
    if (country !== "IN") {
      throw new BadRequestException(
        `India statutory export builders cannot prepare filings for entity country ${country}. Non-IN local filings are not implemented.`,
      );
    }
    if (!body.ruleVersion) return;
    const ruleCountry = body.ruleVersion.split("-")[0] ?? "";
    if (ruleCountry.length === 2) {
      this.entities.assertNoCountryContamination(entity.countryCode, ruleCountry);
    }
    if (ruleCountry.length === 2 && ruleCountry !== "IN") {
      throw new BadRequestException(
        `Cannot apply ${body.ruleVersion} rules to an India-scoped filing export`,
      );
    }
  }
}
