import { Controller, Get, HttpCode, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TaxService } from "./tax.service";
import {
  hrTaxCreateOrUpdateSchema,
  hrTaxAddProofSchema,
  type HrTaxCreateOrUpdateInput,
  type HrTaxAddProofInput,
} from "./dto/payroll.schemas";

@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/payroll/tax")
export class TaxController {
  constructor(private readonly service: TaxService) {}

  @Get()
  @RequirePermission("hr:payroll:view")
  listAll(@CurrentUser() u: CurrentUserContext, @Query("year") year?: string) {
    return this.service.listByOrg(u.orgId, year);
  }

  @Get("mine")
  @RequirePermission("hr:payroll:view")
  listMine(@CurrentUser() u: CurrentUserContext) {
    return this.service.listMine(u.orgId, u.userId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:payroll:view")
  createOrUpdate(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(hrTaxCreateOrUpdateSchema)) body: HrTaxCreateOrUpdateInput,
  ) {
    return this.service.createOrUpdate(u.orgId, u.userId, body);
  }

  @Patch(":declarationId/verify")
  @RequirePermission("hr:tax:manage")
  verify(@CurrentUser() u: CurrentUserContext, @Param("declarationId", ParseIntPipe) declarationId: number) {
    return this.service.verify(u.orgId, declarationId, u.userId);
  }

  @Post(":declarationId/proofs")
  @HttpCode(201)
  @RequirePermission("hr:payroll:view")
  addProof(
    @CurrentUser() u: CurrentUserContext,
    @Param("declarationId", ParseIntPipe) declarationId: number,
    @Body(new ZodValidationPipe(hrTaxAddProofSchema)) body: HrTaxAddProofInput,
  ) {
    return this.service.addProof(u.orgId, declarationId, body);
  }

  @Get(":declarationId/proofs")
  @RequirePermission("hr:payroll:view")
  listProofs(@CurrentUser() u: CurrentUserContext, @Param("declarationId", ParseIntPipe) declarationId: number) {
    return this.service.listProofs(u.orgId, declarationId);
  }
}
