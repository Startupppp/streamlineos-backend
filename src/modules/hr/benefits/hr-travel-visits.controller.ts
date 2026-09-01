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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { HrTravelVisitsService } from "./hr-travel-visits.service";
import { createVisitLogSchema, type CreateVisitLogInput } from "./dto/benefits.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const travelRequestIdParams = z.object({ travelRequestId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/travel-visits")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrTravelVisitsController {
  constructor(private readonly service: HrTravelVisitsService) {}

  @Get(":travelRequestId")
  @RequirePermission("hr:benefits:view")
  @Validate({ params: travelRequestIdParams })
  listVisits(
    @CurrentUser() u: CurrentUserContext,
    @Param("travelRequestId", ParseIntPipe) travelRequestId: number,
  ) {
    return this.service.listVisits(u.orgId, travelRequestId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:benefits:view")
  @Validate({ body: createVisitLogSchema })
  addVisit(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateVisitLogInput,
  ) {
    return this.service.addVisit(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }
}
