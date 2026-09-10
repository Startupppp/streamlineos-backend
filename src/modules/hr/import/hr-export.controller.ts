import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { pipeline } from "node:stream/promises";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { AccessService } from "../../access/access.service";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { resolveEmployeesScope } from "../directory/employees-scope";
import {
  createEmployeeExportJobSchema,
  exportJobIdSchema,
  type CreateEmployeeExportJobInput,
} from "./dto/export-job.dto";
import {
  HrExportJobsService,
  type HrExportJobView,
} from "./hr-export-jobs.service";
import { HrExportWorkerService } from "./hr-export-worker.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { ApiOkResponse } from "@nestjs/swagger";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { hrExportJobViewSchema } from "./dto/import-response.schemas";
import { z } from "zod";

const exportJobIdParams = z.object({ exportJobId: z.string().uuid() }).strict();

@RequireModule("hr")
@RequirePermission("hr:export:manage")
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/export/jobs")
export class HrExportController {
  constructor(
    private readonly jobs: HrExportJobsService,
    private readonly worker: HrExportWorkerService,
    private readonly access: AccessService,
  ) {}

  @Post()
  @ResponseSchema(hrExportJobViewSchema)
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("hr:employee-export")
  @Idempotent("hr.employee-export.create")
  @Validate({ body: createEmployeeExportJobSchema })
  async create(
    @Body() body: CreateEmployeeExportJobInput,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<HrExportJobView> {
    const read = await resolveEmployeesScope(this.access, user);
    const scope = read.rawScope(
      "HrExportJobsService.create persists and later narrows the requested DataScope for a background export job — not a row predicate, and outside this migration's lane",
    );
    const job = await this.jobs.create(user, body, scope, idempotencyKey);
    this.worker.wake();
    return job;
  }

  @Get(":exportJobId")
  @ResponseSchema(hrExportJobViewSchema)
  @Validate({ params: exportJobIdParams })
  get(
    @Param("exportJobId") exportJobId: string,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<HrExportJobView> {
    return this.jobs.getForRequester(user.orgId, user.userId, exportJobId);
  }

  @Get(":exportJobId/download")
  @ApiOkResponse({ description: "Employee data CSV file download", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } })
  @UseGuards(RateLimitGuard)
  @UseRateLimit("hr:employee-export")
  @Validate({ params: exportJobIdParams })
  async download(
    @Param("exportJobId") exportJobId: string,
    @CurrentUser() user: CurrentUserContext,
    @Res() response: Response,
  ): Promise<void> {
    const { job, file } = await this.jobs.getDownload(
      user.orgId,
      user.userId,
      exportJobId,
    );
    const fileName = (job.fileName ?? "employee-directory.csv").replace(/[^a-zA-Z0-9_.-]/g, "-");
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    response.setHeader("Cache-Control", "private, no-store");
    if (file.contentLength !== undefined) {
      response.setHeader("Content-Length", String(file.contentLength));
    }
    await this.jobs.recordDownload(user.orgId, user.userId, job);
    await pipeline(file.body, response);
  }
}
