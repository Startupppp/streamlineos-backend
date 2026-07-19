import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { FnfInsightsService } from "./fnf.service";
import { patchFnfSchema, type PatchFnfInput } from "../../hr-payroll/dto/payroll.schemas";

@Controller("payroll/fnf")
@UseGuards(JwtAuthGuard)
export class FnfController {
  constructor(private readonly fnfService: FnfInsightsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:fnf:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.fnfService.list(u.orgId, u.userId, true);
  }

  @Get(":settlementId")
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:fnf:view")
  getOne(
    @CurrentUser() u: CurrentUserContext,
    @Param("settlementId", ParseIntPipe) settlementId: number,
  ) {
    return this.fnfService.getOne(u.orgId, settlementId);
  }

  @Post(":settlementId/approve")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:fnf:manage")
  approve(
    @CurrentUser() u: CurrentUserContext,
    @Param("settlementId", ParseIntPipe) settlementId: number,
    @Body(new ZodValidationPipe(patchFnfSchema)) body: PatchFnfInput,
  ) {
    return this.fnfService.approve(u.orgId, settlementId, u.userId, body);
  }

  @Get(":settlementId/statement")
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:fnf:view")
  getStatement(
    @CurrentUser() u: CurrentUserContext,
    @Param("settlementId", ParseIntPipe) settlementId: number,
  ) {
    return this.fnfService.getStatement(u.orgId, settlementId);
  }

  @Get(":settlementId/statement/download")
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:fnf:view")
  downloadStatement(
    @CurrentUser() u: CurrentUserContext,
    @Param("settlementId", ParseIntPipe) settlementId: number,
  ): Promise<StreamableFile> {
    return this.fnfService.downloadStatement(u.orgId, settlementId);
  }
}
