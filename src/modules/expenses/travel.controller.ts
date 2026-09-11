import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { TravelService } from "./travel.service";
import {
  createTravelRequestSchema,
  rejectTravelRequestSchema,
  type CreateTravelRequestInput,
  type RejectTravelRequestInput,
} from "./dto/travel.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { travelRequestSchema } from "./dto/travel-response.schemas";

const travelRequestIdParams = z.object({ travelRequestId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/travel")
export class TravelController {
  constructor(private readonly service: TravelService) {}

  @Get()
  @RequirePermission("hr:travel:view")
  @ResponseSchema(z.array(travelRequestSchema))
  listMine(@CurrentUser() u: CurrentUserContext) {
    return this.service.listMine(u.orgId, u.userId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:travel:create")
  @Validate({ body: createTravelRequestSchema })
  @ResponseSchema(travelRequestSchema)
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateTravelRequestInput,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Get("approvals")
  @RequirePermission("hr:travel:manage")
  @ResponseSchema(z.array(travelRequestSchema))
  listPending(@CurrentUser() u: CurrentUserContext) {
    return this.service.listPending(u.orgId);
  }

  @Patch(":travelRequestId/manager-approve")
  @RequirePermission("hr:travel:manage")
  @Validate({ params: travelRequestIdParams })
  @BodylessAction()
  @ResponseSchema(travelRequestSchema)
  managerApprove(
    @CurrentUser() u: CurrentUserContext,
    @Param("travelRequestId", ParseIntPipe) travelRequestId: number,
  ) {
    return this.service.managerApprove(u.orgId, travelRequestId, u.userId);
  }

  @Patch(":travelRequestId/finance-approve")
  @RequirePermission("hr:travel:manage")
  @Validate({ params: travelRequestIdParams })
  @BodylessAction()
  @ResponseSchema(travelRequestSchema)
  financeApprove(
    @CurrentUser() u: CurrentUserContext,
    @Param("travelRequestId", ParseIntPipe) travelRequestId: number,
  ) {
    return this.service.financeApprove(u.orgId, travelRequestId, u.userId);
  }

  @Patch(":travelRequestId/reject")
  @Idempotent("expenses.travel.reject")
  @RequirePermission("hr:travel:manage")
  @Validate({ params: travelRequestIdParams, body: rejectTravelRequestSchema })
  @ResponseSchema(travelRequestSchema)
  reject(
    @CurrentUser() u: CurrentUserContext,
    @Param("travelRequestId", ParseIntPipe) travelRequestId: number,
    @Body() body: RejectTravelRequestInput,
  ) {
    return this.service.reject(u.orgId, travelRequestId, body.reason);
  }
}
