import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { TaxService } from "./tax.service";

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
  @RequirePermission("hr:payroll:view")
  createOrUpdate(@CurrentUser() u: CurrentUserContext, @Body() body: Record<string, unknown>) {
    return this.service.createOrUpdate(u.orgId, u.userId, body as Parameters<TaxService["createOrUpdate"]>[2]);
  }

  @Patch(":id/verify")
  @RequirePermission("hr:tax:manage")
  verify(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.verify(u.orgId, id, u.userId);
  }

  @Post(":id/proofs")
  @RequirePermission("hr:payroll:view")
  addProof(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.addProof(u.orgId, id, body as Parameters<TaxService["addProof"]>[2]);
  }

  @Get(":id/proofs")
  @RequirePermission("hr:payroll:view")
  listProofs(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.listProofs(u.orgId, id);
  }
}
