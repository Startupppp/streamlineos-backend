import {
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotificationsService } from "./notifications.service";
import { listSchema, type ListInput } from "./dto/notification.schemas";

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

  @Patch(":notificationId/read")
  markRead(
    @Param("notificationId", ParseIntPipe) notificationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.notifications.markRead(u.orgId, u.userId, notificationId);
  }
}
