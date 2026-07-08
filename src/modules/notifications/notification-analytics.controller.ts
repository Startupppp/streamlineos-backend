import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { NotificationAnalyticsService } from "./notification-analytics.service";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

const daysSchema = z.object({
  days: z.coerce.number().min(1).max(365).optional().default(30),
});

type DaysInput = z.infer<typeof daysSchema>;

@Controller("notification-analytics")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NotificationAnalyticsController {
  constructor(private readonly analytics: NotificationAnalyticsService) {}

  @Get()
  @RequirePermission("notifications:analytics:view")
  overview(
    @Query(new ZodValidationPipe(daysSchema)) q: DaysInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getOverview(u.orgId, q.days);
  }

  @Get("categories")
  @RequirePermission("notifications:analytics:view")
  byCategory(
    @Query(new ZodValidationPipe(daysSchema)) q: DaysInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getByCategory(u.orgId, q.days);
  }

  @Get("priorities")
  @RequirePermission("notifications:analytics:view")
  byPriority(
    @Query(new ZodValidationPipe(daysSchema)) q: DaysInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getByPriority(u.orgId, q.days);
  }

  @Get("channels")
  @RequirePermission("notifications:analytics:view")
  byChannel(
    @Query(new ZodValidationPipe(daysSchema)) q: DaysInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getByChannel(u.orgId, q.days);
  }
}
