import { Controller, Get, HttpCode, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AllowancesService } from "./allowances.service";
import {
  createAllowanceSchema,
  updateAllowanceSchema,
  type CreateAllowanceInput,
  type UpdateAllowanceInput,
} from "./dto/payroll.schemas";

@UseGuards(JwtAuthGuard)
@Controller("hr/payroll/allowances")
export class AllowancesController {
  constructor(private readonly service: AllowancesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createAllowanceSchema)) body: CreateAllowanceInput,
  ) {
    return this.service.create(u.orgId, body);
  }

  @Patch(":allowanceId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("allowanceId", ParseIntPipe) allowanceId: number,
    @Body(new ZodValidationPipe(updateAllowanceSchema)) body: UpdateAllowanceInput,
  ) {
    return this.service.update(u.orgId, allowanceId, body);
  }

  @Delete(":allowanceId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  remove(@CurrentUser() u: CurrentUserContext, @Param("allowanceId", ParseIntPipe) allowanceId: number) {
    return this.service.remove(u.orgId, allowanceId);
  }
}
