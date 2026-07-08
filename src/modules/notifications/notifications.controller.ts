import {
  Body,
  Controller,
  Delete,
  Get,
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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { Public } from "../../common/auth/public.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotificationsService } from "./notifications.service";
import { NotificationEventService } from "./notification-event.service";
import {
  listSchema,
  snoozeSchema,
  bulkActionSchema,
  auditLogsSchema,
  type ListInput,
  type SnoozeInput,
  type BulkActionInput,
  type AuditLogsInput,
} from "./dto/notification.schemas";

@Controller("notifications")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly notifEvents: NotificationEventService,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.list(u.orgId, u.userId, filters);
  }

  @Get("unread-count")
  unreadCount(@CurrentUser() u: CurrentUserContext) {
    return this.notifications.unreadCount(u.orgId, u.userId);
  }

  @Get("audit")
  @RequirePermission("notifications:audit:view")
  listAuditLogs(
    @Query(new ZodValidationPipe(auditLogsSchema)) filters: AuditLogsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.listAuditLogs(u.orgId, filters);
  }

  @Post("events/token")
  generateStreamToken(@CurrentUser() u: CurrentUserContext) {
    const token = this.notifEvents.generateToken(u.userId, u.orgId);
    return { token };
  }

  @Get("events")
  @Sse()
  @Public()
  stream(@Query("token") token: string): Observable<MessageEvent> {
    const user = this.notifEvents.consumeToken(token);
    if (!user) throw new UnauthorizedException("Invalid or expired stream token");
    return this.notifEvents.stream(user.userId, user.orgId);
  }

  @Patch("read-all")
  markAllRead(@CurrentUser() u: CurrentUserContext) {
    return this.notifications.markAllRead(u.orgId, u.userId);
  }

  @Delete("clear-all")
  clearAll(@CurrentUser() u: CurrentUserContext) {
    return this.notifications.clearAll(u.orgId, u.userId);
  }

  @Post("bulk/read")
  bulkMarkRead(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.bulkMarkRead(u.orgId, u.userId, body);
  }

  @Post("bulk/archive")
  bulkArchive(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.bulkArchive(u.orgId, u.userId, body);
  }

  @Post("bulk/delete")
  bulkDelete(
    @Body(new ZodValidationPipe(bulkActionSchema)) body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.bulkDelete(u.orgId, u.userId, body);
  }

  @Patch(":notificationId/read")
  markRead(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.markRead(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/archive")
  archive(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.archive(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/unarchive")
  unarchive(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.unarchive(u.orgId, u.userId, notificationId);
  }

  @Delete(":notificationId")
  softDelete(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.softDelete(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/pin")
  pin(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.pin(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/unpin")
  unpin(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.unpin(u.orgId, u.userId, notificationId);
  }

  @Patch(":notificationId/snooze")
  snooze(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @Body(new ZodValidationPipe(snoozeSchema)) body: SnoozeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.snooze(u.orgId, u.userId, notificationId, body);
  }

  @Post(":notificationId/approve")
  approve(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.approve(u.orgId, u.userId, notificationId);
  }

  @Post(":notificationId/reject")
  reject(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.reject(u.orgId, u.userId, notificationId);
  }
}
