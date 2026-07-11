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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TeamEventsService } from "./team-events.service";
import { createTeamEventSchema, type CreateTeamEventInput } from "./dto/hr-directory.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/team-events")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TeamEventsController {
  constructor(private readonly teamEvents: TeamEventsService) {}

  @Get()
  @RequirePermission("hr:employees:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.teamEvents.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  createEvent(
    @Body(new ZodValidationPipe(createTeamEventSchema)) body: CreateTeamEventInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.teamEvents.create(u.orgId, u.userId, body);
  }

  @Post(":eventId")
  @HttpCode(201)
  @RequirePermission("hr:employees:view")
  joinEvent(@Param("eventId", ParseIntPipe) eventId: number, @CurrentUser() u: CurrentUserContext) {
    return this.teamEvents.joinEvent(u.orgId, u.userId, eventId);
  }
}
