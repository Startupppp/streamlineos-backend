import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { ShiftsService } from "./shifts.service";
import {
  createShiftSchema,
  updateShiftSchema,
  assignShiftSchema,
  createSwapRequestSchema,
  updateSwapStatusSchema,
  type CreateShiftInput,
  type UpdateShiftInput,
  type AssignShiftInput,
  type CreateSwapRequestInput,
  type UpdateSwapStatusInput,
} from "./dto/shifts.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  shiftTemplateRowSchema,
  shiftAssignmentRowSchema,
  shiftSwapRowSchema,
} from "./dto/time-wfh-shifts-response.schemas";

const shiftIdParams = z.object({ shiftId: z.coerce.number().int().positive() }).strict();
const swapIdParams = z.object({ swapId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/shifts")
export class ShiftsController {
  constructor(private readonly service: ShiftsService) {}

  @Get()
  @ResponseSchema(z.array(shiftTemplateRowSchema))
  @RequirePermission("hr:attendance:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.listShifts(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @ResponseSchema(shiftTemplateRowSchema)
  @RequirePermission("hr:attendance:manage")
  @Validate({ body: createShiftSchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateShiftInput,
  ) {
    return this.service.createShift(u.orgId, body);
  }

  @Patch(":shiftId")
  @ResponseSchema(shiftTemplateRowSchema)
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: shiftIdParams, body: updateShiftSchema })
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("shiftId", ParseIntPipe) shiftId: number,
    @Body() body: UpdateShiftInput,
  ) {
    return this.service.updateShift(u.orgId, shiftId, body);
  }

  @Delete(":shiftId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: shiftIdParams })
  remove(@CurrentUser() u: CurrentUserContext, @Param("shiftId", ParseIntPipe) shiftId: number) {
    return this.service.deleteShift(u.orgId, shiftId);
  }

  @Get("assignments")
  @ResponseSchema(z.array(shiftAssignmentRowSchema))
  @RequirePermission("hr:attendance:view")
  getAssignments(@CurrentUser() u: CurrentUserContext) {
    return this.service.getEmployeeShifts(u.orgId);
  }

  @Post("assignments")
  @HttpCode(201)
  @ResponseSchema(shiftAssignmentRowSchema)
  @RequirePermission("hr:attendance:manage")
  @Validate({ body: assignShiftSchema })
  assign(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: AssignShiftInput,
  ) {
    return this.service.assignShift(u.orgId, body);
  }

  @Get("swaps")
  @ResponseSchema(z.array(shiftSwapRowSchema))
  @RequirePermission("hr:attendance:view")
  listSwaps(@CurrentUser() u: CurrentUserContext) {
    return this.service.listSwapRequests(u.orgId);
  }

  @Post("swaps")
  @HttpCode(201)
  @ResponseSchema(shiftSwapRowSchema)
  @RequirePermission("hr:attendance:view")
  @Validate({ body: createSwapRequestSchema })
  createSwap(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateSwapRequestInput,
  ) {
    return this.service.createSwapRequest(u.orgId, { ...body, requesterId: u.userId });
  }

  @Patch("swaps/:swapId")
  @ResponseSchema(shiftSwapRowSchema)
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: swapIdParams, body: updateSwapStatusSchema })
  updateSwap(
    @CurrentUser() u: CurrentUserContext,
    @Param("swapId", ParseIntPipe) swapId: number,
    @Body() body: UpdateSwapStatusInput,
  ) {
    return this.service.updateSwapStatus(u.orgId, swapId, body.status, u.userId);
  }
}
