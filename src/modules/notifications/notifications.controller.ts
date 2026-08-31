import {
  Body,
  Controller,
  Delete,
  Get,
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
import { Universal } from "../../common/auth/universal.decorator";
import { Public } from "../../common/auth/public.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { NotificationsService } from "./notifications.service";
import { NotificationEventService } from "./notification-event.service";
import { NoTenantTransaction } from "../../common/tenant";
import {
  listSchema,
  snoozeSchema,
  bulkActionSchema,
  type ListInput,
  type SnoozeInput,
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
  @Universal()
  @Validate({ query: listSchema })
  list(
    @Query() filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.list(u.orgId, u.userId, filters);
  }

  @Get("unread-count")
  @Universal()
  unreadCount(@CurrentUser() u: CurrentUserContext) {
    return this.notifications.unreadCount(u.orgId, u.userId);
  }

  @Post("events/token")
  @Universal()
  @UseGuards(RateLimitGuard)
  @UseRateLimit("notifications:stream-token")
  @HttpCode(200)
  generateStreamToken(@CurrentUser() u: CurrentUserContext) {
    const token = this.notifEvents.generateToken(u.userId, u.orgId);
    return { token };
  }

  @Get("events")
  @Sse()
  @Public()
  @NoTenantTransaction()
  stream(
    @Query("token") queryToken: string | undefined,
    @Headers("authorization") authorization: string | undefined,
  ): Observable<MessageEvent> {
    const token = queryToken ?? (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined);
    if (!token) throw new UnauthorizedException("Invalid or expired stream token");
    const user = this.notifEvents.consumeToken(token);
    if (!user) throw new UnauthorizedException("Invalid or expired stream token");
    return this.notifEvents.stream(user.userId, user.orgId);
  }

  @Patch("read-all")
  @Universal()
  markAllRead(@CurrentUser() u: CurrentUserContext) {
    return this.notifications.markAllRead(u.orgId, u.userId);
  }

  @Delete("clear-all")
  @Universal()
  clearAll(@CurrentUser() u: CurrentUserContext) {
    return this.notifications.clearAll(u.orgId, u.userId);
  }

  @Post("bulk/read")
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
  @Universal()
  @Validate({ params: notificationIdParams })
  markRead(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.markRead(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/archive")
  @Universal()
  @Validate({ params: notificationIdParams })
  archive(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.archive(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/unarchive")
  @Universal()
  @Validate({ params: notificationIdParams })
  unarchive(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.unarchive(u.orgId, u.userId, notificationId);
  }

  @Delete(":notificationId")
  @Universal()
  @Validate({ params: notificationIdParams })
  softDelete(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.softDelete(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/pin")
  @Universal()
  @Validate({ params: notificationIdParams })
  pin(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.pin(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/unpin")
  @Universal()
  @Validate({ params: notificationIdParams })
  unpin(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.unpin(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/snooze")
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
