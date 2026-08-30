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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PayrollFilingsService } from "./filings.service";
import {
  prepareFilingSchema,
  type PrepareFilingInput,
  attachAcknowledgementSchema,
  type AttachAcknowledgementInput,
} from "./dto/filings.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const filingIdParams = z.object({ filingId: z.coerce.number().int().positive() }).strict();
const filingIduserIdParams = z.object({ filingId: z.coerce.number().int().positive(), userId: z.string().min(1) }).strict();

@RequireModule("payroll")
@Controller("payroll/filings")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
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
  @Validate({ params: filingIdParams })
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
  @Validate({ params: filingIdParams })
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
  @Validate({ params: filingIduserIdParams })
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
  @Validate({ params: filingIdParams })
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
    @Body(new ZodValidationPipe(prepareFilingSchema)) body: PrepareFilingInput,
  ) {
    return this.service.prepareExport(u.orgId, u.userId, body);
  }

  @Patch(":filingId/acknowledgement")
  @RequirePermission("payroll:tax:manage")
  @Validate({ params: filingIdParams })
  ack(
    @CurrentUser() u: CurrentUserContext,
    @Param("filingId", ParseIntPipe) filingId: number,
    @Body(new ZodValidationPipe(attachAcknowledgementSchema)) body: AttachAcknowledgementInput,
  ) {
    return this.service.attachAcknowledgement(u.orgId, filingId, body);
  }
}
