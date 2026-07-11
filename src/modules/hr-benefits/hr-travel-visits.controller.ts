import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrTravelVisitsService } from "./hr-travel-visits.service";
import { createVisitLogSchema, type CreateVisitLogInput } from "./dto/benefits.schemas";

@RequireModule("hr")
@Controller("hr/travel-visits")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrTravelVisitsController {
  constructor(private readonly service: HrTravelVisitsService) {}

  @Get(":travelRequestId")
  @RequirePermission("hr:benefits:view")
  listVisits(
    @CurrentUser() u: CurrentUserContext,
    @Param("travelRequestId", ParseIntPipe) travelRequestId: number,
  ) {
    return this.service.listVisits(u.orgId, travelRequestId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:benefits:view")
  addVisit(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createVisitLogSchema)) body: CreateVisitLogInput,
  ) {
    return this.service.addVisit(u.orgId, u.userId, body);
  }
}
