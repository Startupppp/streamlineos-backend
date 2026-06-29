import {
  Body,
  Controller,
  ForbiddenException,
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
import { TeamEventsService } from "./team-events.service";
import { userCan } from "./ability.helpers";
import { createTeamEventSchema, type CreateTeamEventInput } from "./dto/hr-directory.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/team-events")
@UseGuards(JwtAuthGuard)
export class TeamEventsController {
  constructor(private readonly teamEvents: TeamEventsService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.teamEvents.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  createEvent(
    @Body(new ZodValidationPipe(createTeamEventSchema)) body: CreateTeamEventInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!userCan(u, "manage", "hr:employees")) {
      throw new ForbiddenException("Only admins can create events.");
    }
    return this.teamEvents.create(u.orgId, u.userId, body);
  }

  @Post(":eventId")
  @HttpCode(201)
  joinEvent(@Param("eventId", ParseIntPipe) eventId: number, @CurrentUser() u: CurrentUserContext) {
    return this.teamEvents.joinEvent(u.orgId, u.userId, eventId);
  }
}
