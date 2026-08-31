import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { PayrollSummaryService } from "./payroll-summary.service";
import { PayrollExportService } from "./payroll-export.service";
import { PayrollSettingsService } from "./payroll-settings.service";
import { AccessService } from "../../access/access.service";
import { resolvePayrollScope } from "../core/timesheets-core-scope";
import {
  periodSummaryQuerySchema,
  exportPayrollSchema,
  exportsListQuerySchema,
  ackExportSchema,
  updateSettingsSchema,
  type PeriodSummaryQuery,
  type ExportPayrollInput,
  type ExportsListQuery,
  type AckExportInput,
  type UpdateSettingsInput,
} from "./dto/payroll.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const exportIdParams = z.object({ exportId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("timesheets/payroll")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayrollController {
  constructor(
    private readonly summary: PayrollSummaryService,
    private readonly exportSvc: PayrollExportService,
    private readonly settings: PayrollSettingsService,
    private readonly access: AccessService,
  ) {}

  @Get("period-summary")
  @RequirePermission("timesheets:payroll:view")
  @Validate({ query: periodSummaryQuerySchema })
  async getPeriodSummary(
    @Query() query: PeriodSummaryQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolvePayrollScope(this.access, u);
    return this.summary.getPeriodSummary(u.orgId, query, scope, u.userId);
  }

  @Post("export")
  @HttpCode(201)
  @RequirePermission("timesheets:payroll:export")
  @Idempotent("timesheets.payroll.export")
  @Validate({ body: exportPayrollSchema })
  runExport(
    @Body() body: ExportPayrollInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exportSvc.runExport(u.orgId, u.userId, body);
  }

  @Get("exports")
  @RequirePermission("timesheets:payroll:view")
  @Validate({ query: exportsListQuerySchema })
  listExports(
    @Query() query: ExportsListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exportSvc.listExports(u.orgId, query);
  }

  @Patch("exports/:exportId/ack")
  @RequirePermission("timesheets:payroll:export")
  @Validate({ params: exportIdParams, body: ackExportSchema })
  ackExport(
    @Param("exportId", ParseIntPipe) exportId: number,
    @Body() body: AckExportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exportSvc.ackExport(u.orgId, u.userId, exportId, body);
  }

  @Get("exports/:exportId/rows")
  @RequirePermission("timesheets:payroll:view")
  @Validate({ params: exportIdParams })
  getExportRows(
    @Param("exportId", ParseIntPipe) exportId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exportSvc.getExportRows(u.orgId, exportId);
  }

  @Get("settings")
  @RequirePermission("timesheets:payroll:view")
  getSettings(@CurrentUser() u: CurrentUserContext) {
    return this.settings.getSettings(u.orgId);
  }

  @Patch("settings")
  @RequirePermission("timesheets:payroll:export")
  @Validate({ body: updateSettingsSchema })
  updateSettings(
    @Body() body: UpdateSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.settings.updateSettings(u.orgId, u.userId, body);
  }
}
