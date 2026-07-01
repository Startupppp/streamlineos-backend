import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { BankTransfersService } from "./bank-transfers.service";

@UseGuards(JwtAuthGuard)
@Controller("hr/payroll/bank-transfers")
export class BankTransfersController {
  constructor(private readonly service: BankTransfersService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:approve")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:approve")
  create(@CurrentUser() u: CurrentUserContext, @Body() body: Record<string, unknown>) {
    return this.service.create(u.orgId, u.userId, body as Parameters<BankTransfersService["create"]>[2]);
  }

  @Patch(":id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:approve")
  updateStatus(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { status: string; referenceNo?: string },
  ) {
    return this.service.updateStatus(u.orgId, id, body);
  }

  @Get(":id/file")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:approve")
  generateFile(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.generateFile(u.orgId, id);
  }
}
