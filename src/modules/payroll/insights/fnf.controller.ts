import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { FnfInsightsService } from "./fnf.service";
import { patchFnfSchema, listPageQuerySchema, type PatchFnfInput, type ListPageQueryInput } from "../hr-payroll/dto/payroll.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const settlementIdParams = z.object({ settlementId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/fnf")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class FnfController {
  constructor(private readonly fnfService: FnfInsightsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:fnf:view")
  @Validate({ query: listPageQuerySchema })
  list(@CurrentUser() u: CurrentUserContext, @Query() query: ListPageQueryInput) {
    return this.fnfService.list(u.orgId, u.userId, true, query.page, query.limit);
  }

  @Get(":settlementId")
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:fnf:view")
  @Validate({ params: settlementIdParams })
  getOne(
    @CurrentUser() u: CurrentUserContext,
    @Param("settlementId", ParseIntPipe) settlementId: number,
  ) {
    return this.fnfService.getOne(u.orgId, settlementId);
  }

  @Post(":settlementId/approve")
  @Idempotent("payroll.fnf.approve")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:fnf:manage")
  @Validate({ params: settlementIdParams, body: patchFnfSchema })
  approve(
    @CurrentUser() u: CurrentUserContext,
    @Param("settlementId", ParseIntPipe) settlementId: number,
    @Body() body: PatchFnfInput,
  ) {
    return this.fnfService.approve(u.orgId, settlementId, u.userId, body);
  }

  @Get(":settlementId/statement")
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:fnf:view")
  @Validate({ params: settlementIdParams })
  getStatement(
    @CurrentUser() u: CurrentUserContext,
    @Param("settlementId", ParseIntPipe) settlementId: number,
  ) {
    return this.fnfService.getStatement(u.orgId, settlementId);
  }

  @Get(":settlementId/statement/download")
  @UseGuards(PermissionGuard)
  @RequirePermission("payroll:fnf:view")
  @Validate({ params: settlementIdParams })
  downloadStatement(
    @CurrentUser() u: CurrentUserContext,
    @Param("settlementId", ParseIntPipe) settlementId: number,
  ): Promise<StreamableFile> {
    return this.fnfService.downloadStatement(u.orgId, settlementId);
  }
}
