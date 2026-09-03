import { Controller, Get, Header, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { once } from "node:events";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { NoTenantTransaction } from "../../common/tenant/no-tenant-transaction.decorator";
import { AuditLogService } from "./audit-log.service";
import {
  exportSchema,
  listSchema,
  type ExportInput,
  type ListInput,
} from "./dto/audit-log.schemas";

@Controller("audit-log")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  @RequirePermission("audit-log:read")
  @Validate({ query: listSchema })
  list(
    @Query() filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.auditLog.list(u.orgId, filters);
  }

  /**
   * `@NoTenantTransaction()` because the generator below is drained across the
   * client's socket: one request transaction would be pinned to a slow client
   * for the whole download. `exportCsvChunks` opens one tenant transaction per
   * keyset page instead, and holds none across a `res.write`.
   */
  @Get("export")
  @RequirePermission("audit-log:read")
  @NoTenantTransaction()
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="audit-log-export.csv"')
  @Validate({ query: exportSchema })
  async exportCsv(
    @Query() filters: ExportInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    for await (const chunk of this.auditLog.exportCsvChunks(u.orgId, filters)) {
      if (res.destroyed) return;
      if (!res.write(chunk)) await once(res, "drain");
    }
    res.end();
  }

  @Get("actions")
  @RequirePermission("audit-log:read")
  listActions(@CurrentUser() u: CurrentUserContext) {
    return this.auditLog.listActions(u.orgId);
  }

  @Get("target-types")
  @RequirePermission("audit-log:read")
  listTargetTypes(@CurrentUser() u: CurrentUserContext) {
    return this.auditLog.listTargetTypes(u.orgId);
  }
}
