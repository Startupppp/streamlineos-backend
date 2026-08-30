import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
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
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { TaxAdminService } from "./tax-admin.service";
import {
  rejectDeclarationSchema,
  type RejectDeclarationInput,
  taxDeclarationsQuerySchema,
  type TaxDeclarationsQuery,
} from "./dto/insights.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const declarationIdParams = z.object({ declarationId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/tax")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class TaxAdminController {
  constructor(private readonly service: TaxAdminService) {}

  @Get("declarations")
  @RequirePermission("payroll:tax:view")
  listDeclarations(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(taxDeclarationsQuerySchema)) query: TaxDeclarationsQuery,
  ) {
    return this.service.listDeclarations(u.orgId, query);
  }

  @Patch("declarations/:declarationId/approve")
  @Idempotent("payroll.tax-declaration.approve")
  @RequirePermission("payroll:tax:manage")
  @Validate({ params: declarationIdParams })
  approve(
    @CurrentUser() u: CurrentUserContext,
    @Param("declarationId", ParseIntPipe) declarationId: number,
  ) {
    return this.service.approve(u.orgId, u.userId, declarationId);
  }

  @Patch("declarations/:declarationId/reject")
  @Idempotent("payroll.tax-declaration.reject")
  @RequirePermission("payroll:tax:manage")
  @Validate({ params: declarationIdParams })
  reject(
    @CurrentUser() u: CurrentUserContext,
    @Param("declarationId", ParseIntPipe) declarationId: number,
    @Body(new ZodValidationPipe(rejectDeclarationSchema)) body: RejectDeclarationInput,
  ) {
    return this.service.reject(u.orgId, declarationId, body.note);
  }

  @Get("export")
  @RequirePermission("payroll:reports:export")
  async export(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(taxDeclarationsQuerySchema)) query: TaxDeclarationsQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.service.exportCsv(u.orgId, query.financialYear);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    return file.body;
  }
}
