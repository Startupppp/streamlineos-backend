import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TravelService } from "./travel.service";
import {
  createTravelRequestSchema,
  rejectTravelRequestSchema,
  type CreateTravelRequestInput,
  type RejectTravelRequestInput,
} from "./dto/travel.schemas";

@RequireModule("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/travel")
export class TravelController {
  constructor(private readonly service: TravelService) {}

  @Get()
  @RequirePermission("hr:travel:view")
  listMine(@CurrentUser() u: CurrentUserContext) {
    return this.service.listMine(u.orgId, u.userId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:travel:create")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createTravelRequestSchema)) body: CreateTravelRequestInput,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Get("approvals")
  @RequirePermission("hr:travel:manage")
  listPending(@CurrentUser() u: CurrentUserContext) {
    return this.service.listPending(u.orgId);
  }

  @Patch(":travelRequestId/manager-approve")
  @RequirePermission("hr:travel:manage")
  managerApprove(
    @CurrentUser() u: CurrentUserContext,
    @Param("travelRequestId", ParseIntPipe) travelRequestId: number,
  ) {
    return this.service.managerApprove(u.orgId, travelRequestId, u.userId);
  }

  @Patch(":travelRequestId/finance-approve")
  @RequirePermission("hr:travel:manage")
  financeApprove(
    @CurrentUser() u: CurrentUserContext,
    @Param("travelRequestId", ParseIntPipe) travelRequestId: number,
  ) {
    return this.service.financeApprove(u.orgId, travelRequestId, u.userId);
  }

  @Patch(":travelRequestId/reject")
  @RequirePermission("hr:travel:manage")
  reject(
    @CurrentUser() u: CurrentUserContext,
    @Param("travelRequestId", ParseIntPipe) travelRequestId: number,
    @Body(new ZodValidationPipe(rejectTravelRequestSchema)) body: RejectTravelRequestInput,
  ) {
    return this.service.reject(u.orgId, travelRequestId, body.reason);
  }
}
