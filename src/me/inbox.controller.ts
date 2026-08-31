import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { Universal } from "../common/auth/universal.decorator";
import { CurrentUser } from "../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../common/auth/backend-claims";
import { Validate } from "../common/validation/validate.decorator";
import { NotificationsService } from "../modules/notifications/notifications.service";
import { UnifiedInboxService } from "../modules/notifications/unified-inbox.service";
import { inboxQuerySchema, type InboxQuery } from "./dto/inbox.schemas";
import {
  unifiedInboxQuerySchema,
  type UnifiedInboxQuery,
} from "../modules/notifications/dto/unified-inbox.schemas";

@Controller("me/inbox")
@UseGuards(JwtAuthGuard)
export class InboxController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly unifiedInbox: UnifiedInboxService,
  ) {}

  @Get()
  @Universal()
  @Validate({ query: inboxQuerySchema })
  list(@Query() query: InboxQuery, @CurrentUser() u: CurrentUserContext) {
    return this.notifications.list(u.orgId, u.userId, {
      section: query.section,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  @Get("count")
  @Universal()
  count(@CurrentUser() u: CurrentUserContext) {
    return this.notifications.unreadCount(u.orgId, u.userId);
  }

  @Get("unified/count")
  @Universal()
  unifiedCount(@CurrentUser() u: CurrentUserContext) {
    return this.unifiedInbox.unifiedUnreadCount(u.orgId, u.userId, u);
  }

  @Get("unified")
  @Universal()
  @Validate({ query: unifiedInboxQuerySchema })
  unified(
    @Query() query: UnifiedInboxQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.unifiedInbox.list(u.orgId, u.userId, query, u);
  }
}
