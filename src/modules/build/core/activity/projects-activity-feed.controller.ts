import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Validate } from "../../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { projectIdParams } from "../dto/build-params.schemas";
import {
  ticketActivityQuerySchema,
  type TicketActivityQuery,
} from "../dto/ticket.schemas";
import { projectActivityPageSchema } from "../dto/project-activity.schemas";
import { ProjectsActivityFeedService } from "./projects-activity-feed.service";

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsActivityFeedController {
  constructor(private readonly activityFeed: ProjectsActivityFeedService) {}

  @Get(":projectId/activity")
  @RequirePermission("build:view")
  @ResponseSchema(projectActivityPageSchema)
  @Validate({ params: projectIdParams, query: ticketActivityQuerySchema })
  getProjectActivity(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: TicketActivityQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.activityFeed.getProjectActivity(u, projectId, {
      limit: query.limit,
      cursor: query.cursor,
    });
  }
}
