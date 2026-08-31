import { Body, Controller, Get, HttpCode, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("hr")
@Controller("hr/work-logs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WorkLogsController {
  constructor(private readonly workLogs: WorkLogsService) {}

  @Get()
  @RequirePermission("hr:attendance:view")
  @Validate({ query: listWorkLogsQuerySchema })
  async list(
    @Query() query: ListWorkLogsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return await this.workLogs.list(u, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:attendance:view")
  @Validate({ body: postWorkLogSchema })
  create(
    @Body() body: PostWorkLogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workLogs.create(u.orgId, u.userId, body, u);
  }

  @Patch("status")
  @RequirePermission("hr:attendance:manage")
  @Validate({ body: patchWorkLogStatusSchema })
  updateStatus(
    @Body() body: PatchWorkLogStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workLogs.updateStatus(u, body);
  }

  @Get("export")
  @RequirePermission("hr:attendance:view")
  @Validate({ query: exportWorkLogsQuerySchema })
  async exportCsv(
    @Query() query: ExportWorkLogsQuery,
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
