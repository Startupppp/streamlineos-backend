import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PayrollJobsService, type PayrollJobType } from "./payroll-jobs.service";
import { PayrollJobsWorkerService } from "./payroll-jobs-worker.service";

const listQuerySchema = z.object({
  failedOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  runId: z.coerce.number().int().positive().optional(),
});

const enqueueSchema = z.object({
  jobType: z.enum([
    "PREVIEW",
    "GENERATE",
    "RECALCULATE",
    "PDF_PUBLISH",
    "EXPORT",
    "RECONCILE",
    "FILING_EXPORT",
  ]),
  runId: z.number().int().positive().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

@Controller("payroll/jobs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayrollJobsController {
  constructor(
    private readonly jobs: PayrollJobsService,
    private readonly worker: PayrollJobsWorkerService,
  ) {}

  @Get()
  @RequirePermission("payroll:runs:view")
  async list(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ) {
    if (query.runId) {
      return this.jobs.listForResource(u.orgId, "payroll_run", String(query.runId));
    }
    return this.jobs.listFailed(u.orgId);
  }

  @Get(":jobId")
  @RequirePermission("payroll:runs:view")
  get(
    @CurrentUser() u: CurrentUserContext,
    @Param("jobId", ParseIntPipe) jobId: number,
  ) {
    return this.jobs.get(u.orgId, jobId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("payroll:runs:manage")
  async enqueue(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(enqueueSchema)) body: z.infer<typeof enqueueSchema>,
  ) {
    const job = await this.jobs.enqueue({
      orgId: u.orgId,
      jobType: body.jobType as PayrollJobType,
      actorId: u.userId,
      resourceType: body.runId ? "payroll_run" : undefined,
      resourceId: body.runId ? String(body.runId) : undefined,
      payload: body.payload,
      idempotencyKey: body.idempotencyKey,
    });
    // Process soon (worker also polls); await one flush for small latency
    void this.worker.flush(5);
    return {
      jobId: job.id,
      status: job.status,
      correlationId: job.correlationId,
      progress: job.progress,
    };
  }

  @Post(":jobId/retry")
  @HttpCode(200)
  @RequirePermission("payroll:runs:manage")
  async retry(
    @CurrentUser() u: CurrentUserContext,
    @Param("jobId", ParseIntPipe) jobId: number,
  ) {
    const row = await this.jobs.retry(u.orgId, jobId);
    void this.worker.flush(5);
    return row;
  }

  @Post("flush")
  @HttpCode(200)
  @RequirePermission("payroll:runs:manage")
  flush() {
    return this.worker.flush(25);
  }
}
