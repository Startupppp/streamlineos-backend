import { Controller, Get, Post, Patch, Param, Body, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { CarriersService } from "./carriers.service";
import { createCarrierSchema, updateCarrierSchema, type CreateCarrierInput, type UpdateCarrierInput } from "./dto/shipments.schemas";

@RequireModule("inventory")
@Controller("inventory/carriers")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class CarriersController {
  constructor(private readonly svc: CarriersService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.svc.list(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  create(
    @Body(new ZodValidationPipe(createCarrierSchema)) body: CreateCarrierInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":carrierId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:shipments:manage")
  update(
    @Param("carrierId", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateCarrierSchema)) body: UpdateCarrierInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, id, body);
  }
}
