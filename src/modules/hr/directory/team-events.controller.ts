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
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { TeamEventsService } from "./team-events.service";
import { createTeamEventSchema, type CreateTeamEventInput } from "./dto/hr-directory.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  teamEventsListSchema,
  teamEventCreateSchema,
  teamEventJoinSchema,
} from "./dto/directory-response.schemas";

const eventIdParams = z.object({ eventId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/team-events")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TeamEventsController {
  constructor(private readonly teamEvents: TeamEventsService) {}

  @Get()
  @ResponseSchema(teamEventsListSchema)
  @RequirePermission("hr:employees:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.teamEvents.list(u.orgId);
  }

  @Post()
  @ResponseSchema(teamEventCreateSchema)
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  @Validate({ body: createTeamEventSchema })
  createEvent(
    @Body() body: CreateTeamEventInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.teamEvents.create(u.orgId, u.userId, body);
  }

  @Post(":eventId")
  @BodylessAction()
  @ResponseSchema(teamEventJoinSchema)
  @HttpCode(201)
  @RequirePermission("hr:employees:view")
  @Validate({ params: eventIdParams })
  joinEvent(@Param("eventId", ParseIntPipe) eventId: number, @CurrentUser() u: CurrentUserContext) {
    return this.teamEvents.joinEvent(u.orgId, u.userId, eventId);
  }
}
