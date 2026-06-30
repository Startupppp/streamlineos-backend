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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotificationsService } from "./notifications.service";
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
  constructor(private readonly notifications: NotificationsService) {}

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
}
