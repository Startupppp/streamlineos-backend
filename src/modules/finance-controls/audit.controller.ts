import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AuditSurfaceService } from "./audit-surface.service";
import { listAuditSchema, type ListAuditQuery } from "./dto/finance-controls.schemas";

@RequireModule("accounting")
@Controller("accounting/audit")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AuditController {
  constructor(private readonly svc: AuditSurfaceService) {}

  @Get()
  @RequirePermission("accounting:audit:read")
  list(
    @Query(new ZodValidationPipe(listAuditSchema)) query: ListAuditQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }

  @Get("record/:resourceType/:resourceId")
  @RequirePermission("accounting:audit:read")
  timeline(
    @Param("resourceType") resourceType: string,
    @Param("resourceId") resourceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.timeline(u.orgId, resourceType, resourceId);
  }

  @Get("export")
  @RequirePermission("accounting:audit:export")
  async export(
    @Query(new ZodValidationPipe(listAuditSchema)) query: ListAuditQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const csv = await this.svc.exportCsv(u.orgId, u.userId, query);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="accounting-audit-${Date.now()}.csv"`);
    res.send(csv);
  }
}
