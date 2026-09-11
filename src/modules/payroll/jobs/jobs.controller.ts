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
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PayrollJobsService } from "./payroll-jobs.service";
import { PayrollJobsWorkerService } from "./payroll-jobs-worker.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { payrollJobListSchema, payrollJobRowSchema, enqueueJobResponseSchema } from "./dto/jobs-response.schemas";
import { listJobsQuerySchema, enqueueJobSchema, type ListJobsQuery, type EnqueueJobInput } from "./dto/jobs.schemas";

const jobIdParams = z.object({ jobId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/jobs")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollJobsController {
  constructor(
    private readonly jobs: PayrollJobsService,
    private readonly worker: PayrollJobsWorkerService,
  ) {}

  @Get()
  @RequirePermission("payroll:runs:view")
  @Validate({ query: listJobsQuerySchema })
  @ResponseSchema(payrollJobListSchema)
  async list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListJobsQuery,
  ) {
    if (query.runId) {
      return this.jobs.listForResource(u.orgId, "payroll_run", String(query.runId), query.cursor, query.limit);
    }
    return this.jobs.listFailed(u.orgId, query.cursor, query.limit);
  }

  @Get(":jobId")
  @RequirePermission("payroll:runs:view")
  @Validate({ params: jobIdParams })
  @ResponseSchema(payrollJobRowSchema)
  get(
    @CurrentUser() u: CurrentUserContext,
    @Param("jobId", ParseIntPipe) jobId: number,
  ) {
    return this.jobs.get(u.orgId, jobId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("payroll:runs:manage")
  @Validate({ body: enqueueJobSchema })
  @ResponseSchema(enqueueJobResponseSchema)
  async enqueue(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: EnqueueJobInput,
  ) {
    const job = await this.jobs.enqueue({
      orgId: u.orgId,
      jobType: body.jobType,
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
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("payroll:runs:manage")
  @Validate({ params: jobIdParams })
  @ResponseSchema(payrollJobRowSchema)
  async retry(
    @CurrentUser() u: CurrentUserContext,
    @Param("jobId", ParseIntPipe) jobId: number,
  ) {
    const row = await this.jobs.retry(u.orgId, jobId);
    void this.worker.flush(5);
    return row;
  }

}
