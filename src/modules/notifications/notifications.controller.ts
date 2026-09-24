import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Sse,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import type { Observable } from "rxjs";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { NO_COMPRESSION_HEADER } from "../../common/http/compression.config";
import { Universal } from "../../common/auth/universal.decorator";
import { Public } from "../../common/auth/public.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { UseAdmissionTenantHint } from "../../common/admission/admission-tenant-hint";
import { UseWorkClass } from "../../common/admission/work-class.decorator";
import { ApiOkResponse } from "@nestjs/swagger";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  notificationCountResponseSchema,
  notificationListResponseSchema,
  notificationStreamTokenResponseSchema,
  notificationSuccessResponseSchema,
} from "./dto/notification-response-schema";
import { NotificationsService } from "./notifications.service";
import { NotificationEventService } from "./notification-event.service";
import { NoTenantTransaction } from "../../common/tenant";
import {
  listSchema,
  snoozeSchema,
  unreadCountSchema,
  bulkActionSchema,
  type ListInput,
  type SnoozeInput,
  type UnreadCountInput,
  type BulkActionInput,
} from "./dto/notification.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const notificationIdParams = z.object({ notificationId: z.coerce.number().int().positive() }).strict();

@Controller("notifications")
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly notifEvents: NotificationEventService,
  ) {}

  @Get()
  @ResponseSchema(notificationListResponseSchema)
  @Universal()
  @Validate({ query: listSchema })
  list(
    @Query() filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.list(u.orgId, u.userId, filters, u.principal);
  }

  @Get("unread-count")
  @ResponseSchema(notificationCountResponseSchema)
  @Universal()
  @Validate({ query: unreadCountSchema })
  unreadCount(@Query() query: UnreadCountInput, @CurrentUser() u: CurrentUserContext) {
    return this.notifications.unreadCount(u.orgId, u.userId, query.sourceModule);
  }

  @Post("events/token")
  @ResponseSchema(notificationStreamTokenResponseSchema)
  @BodylessAction()
  @Universal()
  // PRD-C089 (BREACH) — this body is a bearer token, `app.enableCors({ credentials: true })`
  // is live, and a compressed length is a cross-origin size oracle. `shouldCompress` checks
  // this opt-out first, so no content type can overrule it.
  @Header(NO_COMPRESSION_HEADER, "1")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("notifications:stream-token")
  @NoTenantTransaction()
  @HttpCode(200)
  generateStreamToken(@CurrentUser() u: CurrentUserContext) {
    const token = this.notifEvents.generateToken(u.userId, u.orgId);
    return { token };
  }

  @Get("events")
  @ApiOkResponse({ description: "Server-sent event stream of notification events", content: { "text/event-stream": { schema: { type: "string" } } } })
  @Sse()
  @Public()
  @NoTenantTransaction()
  @UseWorkClass("non-mandatory-notification")
  @UseAdmissionTenantHint(NotificationEventService)
  stream(
    @Headers("authorization") authorization: string | undefined,
  ): Observable<MessageEvent> {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!token) throw new UnauthorizedException("Invalid or expired stream token");
    const user = this.notifEvents.consumeToken(token);
    if (!user) throw new UnauthorizedException("Invalid or expired stream token");
    return this.notifEvents.stream(user.userId, user.orgId);
  }

  @Patch("read-all")
  @ResponseSchema(notificationSuccessResponseSchema)
  @BodylessAction()
  @Universal()
  markAllRead(@CurrentUser() u: CurrentUserContext) {
    return this.notifications.markAllRead(u.orgId, u.userId);
  }

  @Delete("clear-all")
  @ResponseSchema(notificationSuccessResponseSchema)
  @Universal()
  clearAll(@CurrentUser() u: CurrentUserContext) {
    return this.notifications.clearAll(u.orgId, u.userId);
  }

  @Post("bulk/read")
  @ResponseSchema(notificationSuccessResponseSchema)
  @Universal()
  @HttpCode(200)
  @Validate({ body: bulkActionSchema })
  bulkMarkRead(
    @Body() body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.bulkMarkRead(u.orgId, u.userId, body);
  }

  @Post("bulk/archive")
  @ResponseSchema(notificationSuccessResponseSchema)
  @Universal()
  @HttpCode(200)
  @Validate({ body: bulkActionSchema })
  bulkArchive(
    @Body() body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.bulkArchive(u.orgId, u.userId, body);
  }

  @Post("bulk/delete")
  @ResponseSchema(notificationSuccessResponseSchema)
  @Universal()
  @HttpCode(200)
  @Validate({ body: bulkActionSchema })
  bulkDelete(
    @Body() body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.bulkDelete(u.orgId, u.userId, body);
  }

  @Patch(":notificationId/read")
  @ResponseSchema(notificationSuccessResponseSchema)
  @BodylessAction()
  @Universal()
  @Validate({ params: notificationIdParams })
  markRead(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.markRead(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/archive")
  @ResponseSchema(notificationSuccessResponseSchema)
  @BodylessAction()
  @Universal()
  @Validate({ params: notificationIdParams })
  archive(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.archive(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/unarchive")
  @ResponseSchema(notificationSuccessResponseSchema)
  @BodylessAction()
  @Universal()
  @Validate({ params: notificationIdParams })
  unarchive(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.unarchive(u.orgId, u.userId, notificationId);
  }

  @Delete(":notificationId")
  @ResponseSchema(notificationSuccessResponseSchema)
  @Universal()
  @Validate({ params: notificationIdParams })
  softDelete(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.softDelete(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/pin")
  @ResponseSchema(notificationSuccessResponseSchema)
  @BodylessAction()
  @Universal()
  @Validate({ params: notificationIdParams })
  pin(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.pin(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/unpin")
  @ResponseSchema(notificationSuccessResponseSchema)
  @BodylessAction()
  @Universal()
  @Validate({ params: notificationIdParams })
  unpin(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.unpin(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/snooze")
  @ResponseSchema(notificationSuccessResponseSchema)
  @Universal()
  @Validate({ params: notificationIdParams, body: snoozeSchema })
  snooze(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @Body() body: SnoozeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.snooze(u.orgId, u.userId, notificationId, body);
  }

  @Post(":notificationId/approve")
  @ResponseSchema(notificationSuccessResponseSchema)
  @BodylessAction()
  @Idempotent("notifications.action.approve")
  @Universal()
  @HttpCode(200)
  @Validate({ params: notificationIdParams })
  approve(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.approve(u.orgId, u.userId, notificationId);
  }

  @Post(":notificationId/reject")
  @ResponseSchema(notificationSuccessResponseSchema)
  @BodylessAction()
  @Idempotent("notifications.action.reject")
  @Universal()
  @HttpCode(200)
  @Validate({ params: notificationIdParams })
  reject(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.reject(u.orgId, u.userId, notificationId);
  }
}
