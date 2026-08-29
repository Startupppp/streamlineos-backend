import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PickWaveService } from "./pick-wave.service";
import {
  confirmPickSchema,
  createWaveSchema,
  reportPickExceptionSchema,
  type ConfirmPickInput,
  type CreateWaveInput,
  type ReportPickExceptionInput,
} from "./dto/picking.schemas";

@RequireModule("inventory")
@Controller("inventory/picking")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class PickWaveController {
  constructor(private readonly waves: PickWaveService) {}

  @Post("waves")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  createWave(
    @Body(new ZodValidationPipe(createWaveSchema)) body: CreateWaveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.waves.createWave(u.orgId, u.userId, body);
  }

  @Get("waves/:pickListId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:read")
  getWave(
    @Param("pickListId", ParseIntPipe) pickListId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.waves.getWave(u.orgId, u.userId, pickListId);
  }

  @Post("waves/:pickListId/confirm")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  confirmPick(
    @IdempotencyKey() idempotencyKey: string,
    @Param("pickListId", ParseIntPipe) pickListId: number,
    @Body(new ZodValidationPipe(confirmPickSchema)) body: ConfirmPickInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.waves.confirmPick(u.orgId, u.userId, pickListId, body, idempotencyKey);
  }

  /**
   * INV-205. Records why a line could not close as asked, which is also what
   * lets a short-picked wave finish -- a picker holding a tote the system will
   * not let them close is exactly the situation this resolves.
   */
  @Post("waves/:pickListId/exception")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  reportException(
    @IdempotencyKey() idempotencyKey: string,
    @Param("pickListId", ParseIntPipe) pickListId: number,
    @Body(new ZodValidationPipe(reportPickExceptionSchema)) body: ReportPickExceptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.waves.reportException(u.orgId, u.userId, pickListId, body, idempotencyKey);
  }
}
