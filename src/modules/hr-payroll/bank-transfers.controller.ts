import { Controller, Get, HttpCode, Post, Patch, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BankTransfersService } from "./bank-transfers.service";
import {
  createBankTransferSchema,
  updateBankTransferStatusSchema,
  type CreateBankTransferInput,
  type UpdateBankTransferStatusInput,
} from "./dto/payroll.schemas";

@Controller("hr/payroll/bank-transfers")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BankTransfersController {
  constructor(private readonly service: BankTransfersService) {}

  @Get()
  @RequirePermission("hr:payroll:approve")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:payroll:approve")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createBankTransferSchema)) body: CreateBankTransferInput,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Patch(":transferId")
  @RequirePermission("hr:payroll:approve")
  updateStatus(
    @CurrentUser() u: CurrentUserContext,
    @Param("transferId", ParseIntPipe) transferId: number,
    @Body(new ZodValidationPipe(updateBankTransferStatusSchema)) body: UpdateBankTransferStatusInput,
  ) {
    return this.service.updateStatus(u.orgId, transferId, body);
  }

  @Get(":transferId/file")
  @RequirePermission("hr:payroll:approve")
  generateFile(@CurrentUser() u: CurrentUserContext, @Param("transferId", ParseIntPipe) transferId: number) {
    return this.service.generateFile(u.orgId, transferId);
  }
}
