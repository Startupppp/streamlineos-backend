import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { Universal } from "../../../../common/auth/universal.decorator";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { EmergencyService } from "./emergency.service";
import {
  createEmergencyEventSchema,
  updateEmergencyEventSchema,
  listEmergencyEventsSchema,
  broadcastSchema,
  respondSchema,
  type CreateEmergencyEventInput,
  type UpdateEmergencyEventInput,
  type ListEmergencyEventsInput,
  type BroadcastInput,
  type RespondInput,
} from "../dto/emergency.schemas";
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";

const eventIdParams = z.object({ eventId: z.string().min(1) }).strict();

@RequireModule("hr")
@Controller("hr/enterprise/ops/emergency")
@UseGuards(JwtAuthGuard)
export class EmergencyController {
  constructor(private readonly svc: EmergencyService) {}

  @Get("events")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:emergency:manage")
  @Validate({ query: listEmergencyEventsSchema })
  listEvents(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListEmergencyEventsInput,
  ) {
    return this.svc.listEvents(user.orgId, query);
  }

  @Get("events/:eventId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:emergency:manage")
  @Validate({ params: eventIdParams })
  getEvent(
    @CurrentUser() user: CurrentUserContext,
    @Param("eventId") eventId: string,
  ) {
    return this.svc.getEvent(user.orgId, eventId);
  }

  @Post("events")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:emergency:manage")
  @Validate({ body: createEmergencyEventSchema })
  createEvent(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateEmergencyEventInput,
  ) {
    return this.svc.createEvent(user.orgId, user.userId, body);
  }

  @Patch("events/:eventId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:emergency:manage")
  @Validate({ params: eventIdParams, body: updateEmergencyEventSchema })
  updateEvent(
    @CurrentUser() user: CurrentUserContext,
    @Param("eventId") eventId: string,
    @Body() body: UpdateEmergencyEventInput,
  ) {
    return this.svc.updateEvent(user.orgId, eventId, body);
  }

  @Delete("events/:eventId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:emergency:manage")
  @Validate({ params: eventIdParams })
  async deleteEvent(
    @CurrentUser() user: CurrentUserContext,
    @Param("eventId") eventId: string,
  ) {
    await this.svc.deleteEvent(user.orgId, eventId);
  }

  @Post("events/:eventId/broadcast")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:emergency:manage")
  @Validate({ params: eventIdParams, body: broadcastSchema })
  broadcast(
    @CurrentUser() user: CurrentUserContext,
    @Param("eventId") eventId: string,
    @Body() body: BroadcastInput,
  ) {
    return this.svc.broadcast(user.orgId, eventId, body);
  }

  @Post("events/:eventId/respond")
  @Universal()
  @Validate({ params: eventIdParams, body: respondSchema })
  respond(
    @CurrentUser() user: CurrentUserContext,
    @Param("eventId") eventId: string,
    @Body() body: RespondInput,
  ) {
    return this.svc.respond(user.orgId, eventId, user.userId, body);
  }

  @Get("events/:eventId/status")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:emergency:manage")
  @Validate({ params: eventIdParams })
  getEventStatus(
    @CurrentUser() user: CurrentUserContext,
    @Param("eventId") eventId: string,
  ) {
    return this.svc.getEventStatus(user.orgId, eventId);
  }
}
