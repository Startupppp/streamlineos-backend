import {
  BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { NotificationEventRegistryService } from "./notification-event-registry.service";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { updateEventPolicySchema, emitEventSchema, type UpdateEventPolicyInput, type EmitEventInput } from "./dto/event.schemas";
import { isNotificationEventKey } from "./notification-events.catalog";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  notificationEmitSchema,
  notificationEventUpdateSchema,
  notificationEventsListSchema,
} from "./dto/notification-admin-response.schemas";

const eventKeyParams = z.object({ eventKey: z.string().min(1) }).strict();

@Controller("notifications/admin/events")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NotificationEventsController {
  constructor(
    private readonly registry: NotificationEventRegistryService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  @Get()
  @ResponseSchema(notificationEventsListSchema)
  @RequirePermission("notifications:events:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.registry.listForOrg(u.orgId);
  }

  @Patch(":eventKey")
  @ResponseSchema(notificationEventUpdateSchema)
  @RequirePermission("notifications:events:manage")
  @Validate({ params: eventKeyParams, body: updateEventPolicySchema })
  update(
    @Param("eventKey") eventKey: string,
    @Body() body: UpdateEventPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.registry.updateOrgEventPolicy(u.orgId, eventKey, body, u.userId);
  }

  @Post("emit")
  @ResponseSchema(notificationEmitSchema)
  @HttpCode(200)
  @RequirePermission("notifications:events:manage")
  @Validate({ body: emitEventSchema })
  emit(
    @Body() body: EmitEventInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!isNotificationEventKey(body.eventKey))
      throw new BadRequestException(`Unknown notification event: ${body.eventKey}`);

    return this.dispatch.emitNow({
      eventKey: body.eventKey,
      orgId: u.orgId,
      actorUserId: body.actorUserId ?? u.userId,
      targetUserIds: body.targetUserIds,
      entityType: body.entityType,
      entityId: body.entityId,
      title: body.title,
      message: body.message,
      link: body.link,
      priority: body.priority,
      variables: body.variables,
      metadata: body.metadata,
    });
  }
}
