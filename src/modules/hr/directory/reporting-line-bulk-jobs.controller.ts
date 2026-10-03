import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ApiOkResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ReportingLineBulkJobsService } from "./reporting-line-bulk-jobs.service";
import {
  bulkJobPageSchema,
  bulkJobSchema,
  commitBulkJobSchema,
  createBulkJobSchema,
  getBulkJobSchema,
  listBulkJobsSchema,
  type CommitBulkJobInput,
  type CreateBulkJobInput,
  type GetBulkJobInput,
  type ListBulkJobsInput,
} from "./dto/reporting-lines-bulk.schemas";
import { reportingLineBulkJobIdParamsSchema } from "./dto/reporting-lines-shared.schemas";

/**
 * Registered before `ReportingLinesController` in `HrDirectoryModule`: both live under
 * `hr/reporting-lines`, and `GET :employeeUserId` registered first would read `bulk-jobs` as an id.
 */
@RequireModule("hr")
@Controller("hr/reporting-lines/bulk-jobs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReportingLineBulkJobsController {
  constructor(private readonly jobs: ReportingLineBulkJobsService) {}

  @Post()
  @RequirePermission("hr:reporting-lines:manage")
  @Idempotent("hr.reporting-line-bulk-jobs.preview")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("hr:reporting-line-bulk-preview")
  @HttpCode(201)
  @Validate({ body: createBulkJobSchema })
  @ResponseSchema(bulkJobSchema)
  preview(@Body() body: CreateBulkJobInput, @CurrentUser() actor: CurrentUserContext) {
    return this.jobs.preview(actor, body);
  }

  @Get()
  @RequirePermission("hr:reporting-lines:manage")
  @Validate({ query: listBulkJobsSchema })
  @ResponseSchema(bulkJobPageSchema)
  list(@Query() query: ListBulkJobsInput, @CurrentUser() actor: CurrentUserContext) {
    return this.jobs.list(actor, query.cursor, query.limit);
  }

  @Get(":jobId")
  @RequirePermission("hr:reporting-lines:manage")
  @Validate({ params: reportingLineBulkJobIdParamsSchema, query: getBulkJobSchema })
  @ResponseSchema(bulkJobSchema)
  get(@Param("jobId") jobId: string, @Query() query: GetBulkJobInput, @CurrentUser() actor: CurrentUserContext) {
    return this.jobs.get(actor, jobId, query.rowCursor);
  }

  @Get(":jobId/failures.csv")
  @RequirePermission("hr:reporting-lines:manage")
  @Validate({ params: reportingLineBulkJobIdParamsSchema })
  @ApiOkResponse({ description: "Rows that did not apply, as CSV", content: { "text/csv": { schema: { type: "string" } } } })
  async failures(@Param("jobId") jobId: string, @CurrentUser() actor: CurrentUserContext, @Res() res: Response) {
    const csv = await this.jobs.failures(actor, jobId);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="reporting-change-${jobId}-failures.csv"`);
    res.send(csv);
  }

  @Post(":jobId/commit")
  @RequirePermission("hr:reporting-lines:manage")
  @Idempotent("hr.reporting-line-bulk-jobs.commit")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("hr:reporting-line-bulk-commit")
  @HttpCode(200)
  @Validate({ params: reportingLineBulkJobIdParamsSchema, body: commitBulkJobSchema })
  @ResponseSchema(bulkJobSchema)
  commit(@Param("jobId") jobId: string, @Body() body: CommitBulkJobInput, @CurrentUser() actor: CurrentUserContext) {
    return this.jobs.commit(actor, jobId, body);
  }
}
