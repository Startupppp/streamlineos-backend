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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrTravelVisitsService } from "./hr-travel-visits.service";
import { createVisitLogSchema, type CreateVisitLogInput } from "./dto/benefits.schemas";

@Controller("hr/travel-visits")
@UseGuards(JwtAuthGuard)
export class HrTravelVisitsController {
  constructor(private readonly service: HrTravelVisitsService) {}

  @Get(":travelRequestId")
  listVisits(
    @CurrentUser() u: CurrentUserContext,
    @Param("travelRequestId", ParseIntPipe) travelRequestId: number,
  ) {
    return this.service.listVisits(u.orgId, travelRequestId);
  }

  @Post()
  @HttpCode(201)
  addVisit(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createVisitLogSchema)) body: CreateVisitLogInput,
  ) {
    return this.service.addVisit(u.orgId, u.userId, body);
  }
}
