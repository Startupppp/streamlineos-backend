import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { toCsv } from "../../inventory/import-export/csv.util";
import { HrImportService } from "./hr-import.service";
import {
  createImportJobSchema,
  exportQuerySchema,
  hrImportEntityValues,
  listImportJobsSchema,
  type CreateImportJobInput,
  type ExportQueryInput,
  type ListImportJobsInput,
} from "./dto/import-job.dto";
import { z } from "zod";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const jobIdParams = z.object({ jobId: z.string().min(1) }).strict();
const entityParams = z.object({ entity: z.string().min(1) }).strict();

const entityParamSchema = z.enum(hrImportEntityValues);

@RequireModule("hr")
@Controller()
@UseGuards(JwtAuthGuard)
export class HrImportController {
  constructor(private readonly importService: HrImportService) {}

  @Post("hr/import/jobs")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:import:manage")
  @Validate({ body: createImportJobSchema })
  createJob(
    @Body() body: CreateImportJobInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.importService.createJob(u.orgId, u.userId, body);
  }

  @Get("hr/import/jobs")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:import:manage")
  @Validate({ query: listImportJobsSchema })
  listJobs(
    @Query() query: ListImportJobsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.importService.listJobs(u.orgId, query);
  }

  @Get("hr/import/jobs/:jobId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:import:manage")
  @Validate({ params: jobIdParams })
  getJob(
    @Param("jobId") jobId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.importService.getJob(u.orgId, jobId);
  }

  @Post("hr/import/jobs/:jobId/commit")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:import:manage")
  @Validate({ params: jobIdParams })
  commitJob(
    @Param("jobId") jobId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.importService.commitJob(u.orgId, u.userId, jobId);
  }

  @Post("hr/import/jobs/:jobId/rollback")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:import:manage")
  @Validate({ params: jobIdParams })
  rollbackJob(
    @Param("jobId") jobId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.importService.rollbackJob(u.orgId, u.userId, jobId);
  }

  @Get("hr/export/:entity")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:export:manage")
  @Validate({ params: entityParams, query: exportQuerySchema })
  async exportEntity(
    @Param("entity") entity: string,
    @Query() query: ExportQueryInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const parsed = entityParamSchema.safeParse(entity);
    if (!parsed.success) throw new BadRequestException(`Invalid entity '${entity}'`);
    const page = await this.importService.exportEntity(u.orgId, parsed.data, query);
    const rows = page.data;
    const headers = Object.keys(rows[0] ?? {});
    const csv = toCsv(headers, rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${parsed.data}-export-${new Date().toISOString().split("T")[0]}.csv"`,
    );
    res.setHeader("X-Has-More", String(page.pagination.hasMore));
    if (page.pagination.nextCursor) {
      res.setHeader("X-Next-Cursor", page.pagination.nextCursor);
    }
    res.send(csv);
  }
}
