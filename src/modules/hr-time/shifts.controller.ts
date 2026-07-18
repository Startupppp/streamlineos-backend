import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ShiftsService } from "./shifts.service";
import {
  createShiftSchema,
  updateShiftSchema,
  type CreateShiftInput,
  type UpdateShiftInput,
} from "./dto/shifts.schemas";

@RequireModule("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/shifts")
export class ShiftsController {
  constructor(private readonly service: ShiftsService) {}

  @Get()
  @RequirePermission("hr:attendance:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.listShifts(u.orgId);
  }

  @Post()
  @RequirePermission("hr:attendance:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createShiftSchema)) body: CreateShiftInput,
  ) {
    return this.service.createShift(u.orgId, body);
  }

  @Patch(":shiftId")
  @RequirePermission("hr:attendance:manage")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("shiftId", ParseIntPipe) shiftId: number,
    @Body(new ZodValidationPipe(updateShiftSchema)) body: UpdateShiftInput,
  ) {
    return this.service.updateShift(u.orgId, shiftId, body);
  }

  @Delete(":shiftId")
  @RequirePermission("hr:attendance:manage")
  remove(@CurrentUser() u: CurrentUserContext, @Param("shiftId", ParseIntPipe) shiftId: number) {
    return this.service.deleteShift(u.orgId, shiftId);
  }

  @Get("assignments")
  @RequirePermission("hr:attendance:view")
  getAssignments(@CurrentUser() u: CurrentUserContext) {
    return this.service.getEmployeeShifts(u.orgId);
  }

  @Post("assignments")
  @RequirePermission("hr:attendance:manage")
  assign(@CurrentUser() u: CurrentUserContext, @Body() body: { userId: string; shiftId: number; effectiveFrom: string; effectiveTo?: string }) {
    return this.service.assignShift(u.orgId, body);
  }

  @Get("swaps")
  @RequirePermission("hr:attendance:view")
  listSwaps(@CurrentUser() u: CurrentUserContext) {
    return this.service.listSwapRequests(u.orgId);
  }

  @Post("swaps")
  @RequirePermission("hr:attendance:view")
  createSwap(@CurrentUser() u: CurrentUserContext, @Body() body: { targetUserId: string; requestDate: string; targetDate: string; reason?: string }) {
    return this.service.createSwapRequest(u.orgId, { ...body, requesterId: u.userId });
  }

  @Patch("swaps/:swapId")
  @RequirePermission("hr:attendance:manage")
  updateSwap(@CurrentUser() u: CurrentUserContext, @Param("swapId", ParseIntPipe) swapId: number, @Body() body: { status: string }) {
    return this.service.updateSwapStatus(u.orgId, swapId, body.status, u.userId);
  }
}
