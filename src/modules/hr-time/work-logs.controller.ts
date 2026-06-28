import { Body, Controller, Get, HttpCode, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { WorkLogsService } from "./work-logs.service";
import {
  exportWorkLogsQuerySchema,
  listWorkLogsQuerySchema,
  patchWorkLogStatusSchema,
  postWorkLogSchema,
  type ExportWorkLogsQuery,
  type ListWorkLogsQuery,
  type PatchWorkLogStatusInput,
  type PostWorkLogInput,
} from "./dto/work-logs.schemas";

@Controller("hr/work-logs")
@UseGuards(JwtAuthGuard)
export class WorkLogsController {
  constructor(private readonly workLogs: WorkLogsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listWorkLogsQuerySchema)) query: ListWorkLogsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return await this.workLogs.list(u, query);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(postWorkLogSchema)) body: PostWorkLogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workLogs.create(u.orgId, u.userId, body);
  }

  @Patch("status")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  updateStatus(
    @Body(new ZodValidationPipe(patchWorkLogStatusSchema)) body: PatchWorkLogStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workLogs.updateStatus(u, body);
  }

  @Get("export")
  async exportCsv(
    @Query(new ZodValidationPipe(exportWorkLogsQuerySchema)) query: ExportWorkLogsQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const csv = await this.workLogs.exportCsv(u, query);
    const filename = `work-logs-${new Date().toISOString().split("T")[0]}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  }
}
