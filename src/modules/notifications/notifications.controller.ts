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
import { Universal } from "../../common/auth/universal.decorator";
import { Public } from "../../common/auth/public.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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

@Controller("notifications")
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly notifEvents: NotificationEventService,
  ) {}

  @Get()
  @Universal()
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
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
  bulkMarkRead(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.bulkMarkRead(u.orgId, u.userId, body);
  }

  @Post("bulk/archive")
  @Universal()
  @HttpCode(200)
  bulkArchive(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.bulkArchive(u.orgId, u.userId, body);
  }

  @Post("bulk/delete")
  @Universal()
  @HttpCode(200)
  bulkDelete(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.bulkDelete(u.orgId, u.userId, body);
  }

  @Patch(":notificationId/read")
  @Universal()
  markRead(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.markRead(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/archive")
  @Universal()
  archive(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.archive(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/unarchive")
  @Universal()
  unarchive(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.unarchive(u.orgId, u.userId, notificationId);
  }

  @Delete(":notificationId")
  @Universal()
  softDelete(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.softDelete(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/pin")
  @Universal()
  pin(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.pin(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/unpin")
  @Universal()
  unpin(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.unpin(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/snooze")
  @Universal()
  snooze(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @Body(new ZodValidationPipe(snoozeSchema)) body: SnoozeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.snooze(u.orgId, u.userId, notificationId, body);
  }

  @Post(":notificationId/approve")
  @Idempotent("notifications.action.approve")
  @Universal()
  @HttpCode(200)
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
  reject(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.reject(u.orgId, u.userId, notificationId);
  }
}
