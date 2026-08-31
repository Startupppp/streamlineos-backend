import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { ActivitiesService } from "./activities.service";
import { MyTasksService } from "./my-tasks.service";
import {
  createActivitySchema,
  myTasksQuerySchema,
  timelineQuerySchema,
  updateActivitySchema,
  type CreateActivityInput,
  type MyTasksQuery,
  type TimelineQuery,
  type UpdateActivityInput,
} from "./dto/activity.schemas";
import { z } from "zod";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const activityIdParams = z.object({ activityId: z.string().min(1) }).strict();

/**
 * One timeline, read by whatever it is anchored to.
 *
 * Deliberately not `/parties/:id/timeline` plus `/deals/:id/timeline` plus a
 * third — five entity-specific timelines already exist in this codebase, each
 * with its own event shape, and none of them covers a deal.
 */
@Controller("crm/activities")
@UseGuards(JwtAuthGuard)
export class ActivitiesController {
  constructor(
    private readonly activities: ActivitiesService,
    private readonly myTasksService: MyTasksService,
  ) {}

  @Get("timeline")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:activities:view")
  @Validate({ query: timelineQuerySchema })
  timeline(@CurrentUser() user: CurrentUserContext, @Query() query: TimelineQuery) {
    return this.activities.timeline(user.orgId, query);
  }

  /** The same rows the timeline shows, read by assignee instead of by anchor. */
  @Get("my-tasks")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:activities:view")
  @Validate({ query: myTasksQuerySchema })
  myTasks(@CurrentUser() user: CurrentUserContext, @Query() query: MyTasksQuery) {
    return this.myTasksService.myTasks(user.orgId, user.userId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:activities:manage")
  @Idempotent("crm.activity.create")
  @Validate({ body: createActivitySchema })
  create(@CurrentUser() user: CurrentUserContext, @Body() body: CreateActivityInput) {
    return this.activities.create(user.orgId, { kind: "human", userId: user.userId }, body);
  }

  @Get(":activityId/participants")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:activities:view")
  @Validate({ params: activityIdParams })
  async participants(
    @CurrentUser() user: CurrentUserContext,
    @Param("activityId") activityId: string,
  ) {
    return { data: await this.activities.participants(user.orgId, activityId) };
  }

  @Patch(":activityId")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:activities:manage")
  @Idempotent("crm.activity.update")
  @Validate({ body: updateActivitySchema, params: activityIdParams })
  update(
    @CurrentUser() user: CurrentUserContext,
    @Param("activityId") activityId: string,
    @Body() body: UpdateActivityInput,
  ) {
    return this.activities.update(
      user.orgId,
      activityId,
      { kind: "human", userId: user.userId },
      body,
    );
  }

  @Post(":activityId/complete")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:activities:manage")
  @Idempotent("crm.activity.complete")
  @Validate({ params: activityIdParams })
  @BodylessAction()
  complete(@CurrentUser() user: CurrentUserContext, @Param("activityId") activityId: string) {
    return this.activities.complete(user.orgId, activityId, {
      kind: "human",
      userId: user.userId,
    });
  }

  @Delete(":activityId")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:activities:manage")
  @Idempotent("crm.activity.delete")
  @Validate({ params: activityIdParams })
  async remove(@CurrentUser() user: CurrentUserContext, @Param("activityId") activityId: string) {
    await this.activities.remove(user.orgId, activityId, {
      kind: "human",
      userId: user.userId,
    });
    return { deleted: true };
  }
}
