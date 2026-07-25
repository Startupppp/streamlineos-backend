import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PayrollFilingsService } from "./filings.service";

const prepareSchema = z.object({
  filingType: z.enum(["PF_ECR", "ESI", "PT", "TDS_24Q", "FORM16", "LWF"]),
  periodId: z.number().int().positive().optional(),
  entityId: z.number().int().positive().optional(),
  fiscalYear: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  ruleVersion: z.string().optional(),
  /** Prefer month of REGULAR run when runId omitted. */
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  runId: z.number().int().positive().optional(),
});

const ackSchema = z.object({
  challanRef: z.string().max(120).optional(),
  acknowledgementRef: z.string().max(120).optional(),
});

@Controller("payroll/filings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayrollFilingsController {
  constructor(private readonly service: PayrollFilingsService) {}

  @Get()
  @RequirePermission("payroll:tax:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Get("capabilities")
  @RequirePermission("payroll:tax:view")
  capabilities() {
    return this.service.capabilities();
  }

  @Get(":filingId/export")
  @RequirePermission("payroll:tax:view")
  async downloadExport(
    @CurrentUser() u: CurrentUserContext,
    @Param("filingId", ParseIntPipe) filingId: number,
    @Res() res: Response,
  ) {
    const file = await this.service.getExportCsv(u.orgId, filingId);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.filename}"`,
    );
    res.send(file.body);
  }

  /** Employees on a FORM16 filing (for period-summary PDF download). */
  @Get(":filingId/form16/employees")
  @RequirePermission("payroll:tax:view")
  listForm16Employees(
    @CurrentUser() u: CurrentUserContext,
    @Param("filingId", ParseIntPipe) filingId: number,
  ) {
    return this.service.listForm16Employees(u.orgId, filingId);
  }

  /**
   * Period-summary Form 16 PDF for one employee.
   * Not an official Part A/B certificate.
   */
  @Get(":filingId/form16/:userId")
  @RequirePermission("payroll:tax:view")
  async downloadForm16Pdf(
    @CurrentUser() u: CurrentUserContext,
    @Param("filingId", ParseIntPipe) filingId: number,
    @Param("userId") userId: string,
    @Res() res: Response,
  ) {
    const file = await this.service.getForm16CertificatePdf(
      u.orgId,
      filingId,
      userId,
    );
    res.setHeader("Content-Type", file.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.filename}"`,
    );
    res.send(file.body);
  }

  @Get(":filingId")
  @RequirePermission("payroll:tax:view")
  get(
    @CurrentUser() u: CurrentUserContext,
    @Param("filingId", ParseIntPipe) filingId: number,
  ) {
    return this.service.get(u.orgId, filingId);
  }

  @Post("export")
  @HttpCode(201)
  @RequirePermission("payroll:tax:manage")
  prepare(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(prepareSchema)) body: z.infer<typeof prepareSchema>,
  ) {
    return this.service.prepareExport(u.orgId, u.userId, body);
  }

  @Patch(":filingId/acknowledgement")
  @RequirePermission("payroll:tax:manage")
  ack(
    @CurrentUser() u: CurrentUserContext,
    @Param("filingId", ParseIntPipe) filingId: number,
    @Body(new ZodValidationPipe(ackSchema)) body: z.infer<typeof ackSchema>,
  ) {
    return this.service.attachAcknowledgement(u.orgId, filingId, body);
  }
}
